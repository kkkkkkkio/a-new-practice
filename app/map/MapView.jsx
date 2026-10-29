"use client";

// 唯一持有状态的组件：起点、时间、出行方式、种类、数据、loading 都在这里。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import FilterBar from "./FilterBar";
import MapCanvas from "./MapCanvas";
import { FILTER_OPTIONS, FILTER_TYPE_IDS, matchesFilter, poiColor, categoryLabel } from "@/lib/categories";
import { DEFAULT_ORIGIN_ID, ORIGINS, originById } from "@/lib/origins";
import {
  distanceMeters,
  formatDistance,
  modeById,
  queryRadius,
  reachRadius,
  timeById,
} from "@/lib/travel";

// 默认「半小时 / 步行」：算出来 2400m，没超过抓取上限，所以请求半径就是 2400。
const DEFAULT_TIME_ID = "30m";
const DEFAULT_MODE_ID = "walk";

// 撤销栈深度（需求 7：最多 3 步）。**只在内存里**，刷新即清空 ——
// 需求明确要求「刷新后撤销次数不恢复」，把栈放内存天然满足。
const UNDO_DEPTH = 3;

// 起点按钮和主色统一，避免又冒出一个新色值
const PRIMARY = "#726fab";

export default function MapView() {
  const [originId, setOriginId] = useState(DEFAULT_ORIGIN_ID);
  const [timeId, setTimeId] = useState(DEFAULT_TIME_ID);
  const [modeId, setModeId] = useState(DEFAULT_MODE_ID);
  // 2026-10-29：分类由「单选一个 id」改成「多选的 id 集合」。
  // 默认 7 个类型全选 = 原来「全部」那个状态；一个都不选 = 原来的「不显示」。
  const [selectedIds, setSelectedIds] = useState(FILTER_TYPE_IDS);

  const [pois, setPois] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dataSource, setDataSource] = useState("");
  // 快照的"上游"是谁（openstreetmap / 空）。OSM 是 ODbL 协议，必须署名，
  // 而 dataSource 只会是 "snapshot"，分不出数据到底来自哪，所以单独记一份。
  const [dataOrigin, setDataOrigin] = useState("");
  const [notice, setNotice] = useState("");

  // 收藏：items 是服务端返回的原始列表（面板要显示名字），keys 是「哪些点已收藏」的索引
  const [favorites, setFavorites] = useState([]);
  const [favOpen, setFavOpen] = useState(false);
  const [favError, setFavError] = useState("");
  const [focusPoi, setFocusPoi] = useState(null);
  // 正在发请求的 key。防止连点两次把同一个点「收藏 → 取消 → 收藏」
  const pendingRef = useRef(new Set());

  // 打卡（2026-10-29）：结构和收藏几乎一样，多一个「面板里改名」和「给路标打卡」。
  const [checkins, setCheckins] = useState([]);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [checkinError, setCheckinError] = useState("");
  // 打卡列表里正在改名的那一行：{ id, value }
  const [renamingCheckin, setRenamingCheckin] = useState(null);
  // 和路标改名同一个套路：提交有多个入口，只允许落一次
  const renameCheckinBusyRef = useRef(false);
  // 「改名提交」的依赖是空数组，读不到最新 state，所以各留一份 ref
  const checkinsRef = useRef(checkins);
  const renameCheckinRef = useRef(renamingCheckin);
  useEffect(() => {
    checkinsRef.current = checkins;
  }, [checkins]);
  useEffect(() => {
    renameCheckinRef.current = renamingCheckin;
  }, [renamingCheckin]);
  const favoritesRef = useRef(favorites);
  useEffect(() => {
    favoritesRef.current = favorites;
  }, [favorites]);

  // 收藏 / 打卡的撤销栈（2026-10-29）。规则和路标完全一样：
  //   **一步 = 一组**（单删一步是 1 条，"全部删除"一步是当时全部 N 条），
  //   深度 3，只在前端内存里（刷新即失效 —— 这是路标那边定的口径，保持一致）。
  const favUndoRef = useRef([]);
  const [favUndoDepth, setFavUndoDepth] = useState(0);
  const checkinUndoRef = useRef([]);
  const [checkinUndoDepth, setCheckinUndoDepth] = useState(0);

  // 需求 5「不显示」模式下唯一还显示的那个点（从收藏夹点进来时就是它）
  const [selectedPoi, setSelectedPoi] = useState(null);

  // ── 特定节点预览（2026-10-29 第三轮）──────────────────────────
  //
  // 从一个窗口（收藏 / 路标）点某个节点，或者点「显示全部收藏 / 路标」，都进这个状态：
  //   { kind: "poi", poi }          只画这一个地点（其他节点全隐藏）
  //   { kind: "waypoint", wp }      只画这一个路标
  //   { kind: "favorites" }         只画全部收藏点
  //   { kind: "waypoints" }         只画全部路标
  // null = 普通浏览。
  //
  // 它取代了上一轮的 solo 布尔量 —— 同样是"只看这几样"，但种类变多了，用布尔量表达不了。
  const [preview, setPreview] = useState(null);
  // 预览时那圈淡蓝色边框的动画状态：从窗口里的那一行飞到地图上，再淡出
  const [frame, setFrame] = useState(null);
  const frameTimers = useRef([]);
  const mapWrapRef = useRef(null);
  // 退出预览时把这个数 +1，地图收到后 easeTo 回初始视野（等价于刚进页面那次）
  const [resetKey, setResetKey] = useState(0);
  // 需求 2 的淡出：同屏实际亮着几个。只是给概况行一句实话用
  const [visibleCount, setVisibleCount] = useState(0);

  // 需求 6/7 路标
  const [waypoints, setWaypoints] = useState([]);
  const [wpOpen, setWpOpen] = useState(false);
  const [wpMode, setWpMode] = useState(false); // 点地图就能放路标
  const [wpError, setWpError] = useState("");
  // 正在改名的那个路标：{ id, value }。null = 没有人在改名。
  // 用 id 而不是 index 记住是谁：改名途中删掉别的路标，下标会错位。
  const [renaming, setRenaming] = useState(null);
  // 改名这条链路上「提交」有两个入口（回车 / ✓ / 失焦），必须只落一次。
  // 用 ref 而不是 state：这层判断在事件里同步执行，state 更新完还来不及生效。
  const renameBusyRef = useRef(false);
  // 撤销栈：存被删掉的路标（坐标 + 名字）。数组尾部是最近一次删除。
  const undoRef = useRef([]);
  const [undoDepth, setUndoDepth] = useState(0); // 只为了让按钮的禁用状态跟着变

  const origin = originById(originId);
  const reach = reachRadius(modeId, timeId); // 理论上这段时间能走多远
  const radius = queryRadius(modeId, timeId); // 真正拿去请求的范围（有上限）

  // 起点或范围变了就重新请求接口（种类不参与请求，切种类不发网络）
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError("");
      setNotice("");
      try {
        const url = `/api/pois?lng=${origin.lng}&lat=${origin.lat}&radius=${radius}`;
        const res = await fetch(url, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error?.message || `HTTP ${res.status}`);
        }
        setPois(data.pois ?? []);
        // dataSource 从响应头读（同源，读得到）；notice 只有降级时才有
        setDataSource(res.headers.get("x-data-source") ?? "");
        setDataOrigin(data?.origin ?? "");
        setNotice(data?.notice ?? "");
      } catch (e) {
        // 切起点时上一个请求会被 abort，这不是错误
        if (e?.name !== "AbortError") setError(e?.message || "请求失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    // 300ms 防抖：「10 分钟 → 半小时 → 一小时」连着点只发最后一次。
    // 光有 AbortController 不够 —— 它只断前端连接，服务端那边该打的
    // 30 个上游请求一个都不会少，额度照扣。
    const timer = setTimeout(load, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // 依赖只写基本类型：origin 对象引用虽然稳定，但写 id 更能表达"换了起点"这件事
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originId, radius]);

  // 种类和「时间可达」都在本地过滤：
  //   - 种类是纯展示筛选，没必要重发请求
  //   - distance <= reach 保证「半小时内」这句话是真的，而不是「半径内」
  //   - 一个类型都没选（原「不显示」）就是「一个点都不画」
  const hidden = selectedIds.length === 0;
  const visiblePois = useMemo(() => {
    if (hidden) return [];
    return pois.filter(
      (p) => selectedIds.some((id) => matchesFilter(p, id)) && p.distance <= reach,
    );
  }, [pois, selectedIds, reach, hidden]);

  const previewKind = preview?.kind ?? null;
  const previewing = previewKind !== null;

  // 收藏点变成能画在地图上的 POI 形状。收藏表存的是快照（没有 lines/kind），
  // 距离要现算；id 直接用 poi_id，弹窗、收藏星标都靠它对齐。
  const favoritePois = useMemo(
    () =>
      favorites.map((f) => ({
        id: f.poi_id,
        name: f.name,
        category: f.category,
        lng: f.lng,
        lat: f.lat,
        address: f.address,
        distance: Math.round(distanceMeters(origin, f)),
      })),
    [favorites, origin],
  );

  // 打卡记录变成能画在地图上的两种形状。
  // 分成两堆是必须的：路标那批得还给路标图层画（红色大 pin），
  // 塞进 POI 图层会因为 category = "waypoint" 在 CATEGORIES 里取不到配色。
  // 这两个 memo 必须排在 canvasPois 之前 —— 依赖数组在渲染期求值，写在后面就是 TDZ 报错。
  const checkinPois = useMemo(
    () =>
      checkins
        .filter((c) => c.source !== "waypoint")
        .map((c) => ({
          id: c.poi_id,
          // label 是「我给这地方起的名字」，优先显示；没改过就用上游原名
          name: c.label || c.name,
          category: c.category,
          lng: c.lng,
          lat: c.lat,
          address: c.address,
          distance: Math.round(distanceMeters(origin, c)),
        })),
    [checkins, origin],
  );

  const checkinWaypoints = useMemo(
    () =>
      checkins
        .filter((c) => c.source === "waypoint")
        .map((c) => {
          const id = Number(String(c.poi_id).replace(/^wp:/, ""));
          // 路标被删了、打卡记录还留着 —— 画不出来就跳过（列表里照旧能看能删）
          return waypoints.find((w) => w.id === id);
        })
        .filter(Boolean),
    [checkins, waypoints],
  );

  // 交给地图画的那份点集。预览各自决定画什么，普通浏览就走筛选结果。
  const canvasPois = useMemo(() => {
    if (previewKind === "poi") return preview.poi ? [preview.poi] : [];
    if (previewKind === "favorites") return favoritePois;
    if (previewKind === "checkin") {
      // 打的是路标的卡 → POI 图层什么都不画（那一个由路标图层负责）
      if (preview.item?.source === "waypoint") return [];
      return checkinPois.filter((p) => p.id === preview.item?.poi_id);
    }
    if (previewKind === "checkins") return checkinPois;
    if (previewKind === "waypoint" || previewKind === "waypoints") return [];
    if (hidden) return selectedPoi ? [selectedPoi] : [];
    return visiblePois;
  }, [previewKind, preview, favoritePois, checkinPois, hidden, selectedPoi, visiblePois]);

  // MapCanvas 的 hidden 语义是「只画 selectedPoi 那一个」，
  // 所以只有「看单个地点」和「不显示 + 有选中的点」这两种情况才置 true。
  const canvasHidden = previewKind === "poi" || (hidden && Boolean(selectedPoi));
  const canvasSinglePoi = previewKind === "poi" ? preview.poi : selectedPoi;

  // 预览单个路标时只画那一个路标；预览打卡时只画「打了卡的路标」；其余情况照常全画
  const canvasWaypoints = useMemo(() => {
    if (previewKind === "waypoint") return [preview.wp];
    if (previewKind === "checkin") {
      if (preview.item?.source !== "waypoint") return [];
      return checkinWaypoints.filter((w) => `wp:${w.id}` === preview.item.poi_id);
    }
    if (previewKind === "checkins") return checkinWaypoints;
    return waypoints;
  }, [previewKind, preview, checkinWaypoints, waypoints]);

  // ── 多选筛选（2026-10-29）────────────────────────────────────
  // 点一个没选的类型 → 加上；再点一次已选的 → 取消。任何一次筛选操作都退出预览，
  // 否则「点了餐饮却还是只有收藏那一个点」，看起来就像筛选坏了。
  //
  // 这里的退出是**收起**而不是"淡出"：用户是主动去改筛选，不是点了 ×，
  // 再播一遍退场动画反而拖沓。所以直接 frame = null。
  const dropPreview = useCallback(() => {
    frameTimers.current.forEach(clearTimeout);
    frameTimers.current = [];
    setFrame(null);
    setPreview(null);
    setSelectedPoi(null);
  }, []);

  const toggleFilter = useCallback(
    (id) => {
      if (preview) dropPreview();
      setSelectedIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    },
    [preview, dropPreview],
  );

  const selectAllFilters = useCallback(() => {
    if (preview) dropPreview();
    setSelectedIds(FILTER_TYPE_IDS);
  }, [preview, dropPreview]);

  const clearFilters = useCallback(() => {
    if (preview) dropPreview();
    setSelectedIds([]);
  }, [preview, dropPreview]);

  // 「这段时间内没有此类地点」只在**真的按筛选查过**时才成立。
  // 「不显示」和预览本来就是一个点都不画 / 只画一个，这时候跳这句话是误导。
  const noResult = !loading && !error && !hidden && !previewing && visiblePois.length === 0;
  // 「能到的范围」比「数据抓取范围」大，就是数据撑不住——必须在图上说清楚，
  // 否则用户切到骑行一小时会以为筛选坏了（圈外确实一个点都没有）
  const clipped = reach > radius;

  // 标记抽稀已经**整块删掉**了：第二轮需求 2 要求的是「密集处淡出、放大恢复」，
  // 而不是「超过多少条就抽掉一部分」。抽样丢掉的点放大也回不来，是对不上需求的。
  // 现在由 MapCanvas 按屏幕像素做淡出判定（40px 内 ≥5 个就只留一个亮点）。
  // 「图上画了几个」也从 MapCanvas 报回来（visibleCount），概况行照它写。

  // 进页面拉一次收藏列表。session 是服务端用 cookie 认的，前端不参与，
  // 所以这里就是最普通的 fetch，不需要带任何东西。
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/favorites");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setFavorites(Array.isArray(data.items) ? data.items : []);
      } catch {
        // 收藏拉不到不该影响看地图，静默失败
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 「是否已收藏」的唯一判断依据。key 里必须带 source：
  // mock 数据和真实数据的 id 是两套，只用 id 会互相冒充。
  const favoriteKeys = useMemo(
    () => new Set(favorites.map((f) => `${f.source}:${f.poi_id}`)),
    [favorites],
  );

  // ── 打卡（2026-10-29）────────────────────────────────────────
  //
  // 和收藏是两套平行的数据，key 规则也照抄（`${source}:${poi_id}`）：
  // 同一个地方可以既收藏又打卡，两者互不影响。
  // 路标用 source = "waypoint"、poi_id = "wp:<id>" —— 这样「只看全部打卡」
  // 能把 POI 和路标混在一张列表里，地图上也能一起画出来。

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/checkins");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setCheckins(Array.isArray(data.items) ? data.items : []);
      } catch {
        // 打卡拉不到不该影响看地图，静默失败
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const checkinKeys = useMemo(
    () => new Set(checkins.map((c) => `${c.source}:${c.poi_id}`)),
    [checkins],
  );

  // 点弹窗里的「打卡 / 已打卡」。payload 有两种：
  //   { kind: "poi", poi, source }     普通地点（弹窗里那颗按钮）
  //   { kind: "waypoint", waypoint }   自己放的路标（路标气泡里那颗按钮）
  const toggleCheckin = useCallback(
    async (target) => {
      const isWp = target.kind === "waypoint";
      const source = isWp ? "waypoint" : target.source;
      if (!source) {
        setCheckinError("数据还没加载完，稍等一下再打卡");
        setCheckinOpen(true);
        return;
      }

      const poiId = isWp ? `wp:${target.waypoint.id}` : target.poi.id;
      const key = `${source}:${poiId}`;
      if (pendingRef.current.has(key)) return;
      pendingRef.current.add(key);
      setCheckinError("");

      try {
        if (checkinKeys.has(key)) {
          const query = `poi_id=${encodeURIComponent(poiId)}&source=${encodeURIComponent(source)}`;
          const res = await fetch(`/api/checkins?${query}`, { method: "DELETE" });
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            throw new Error(data?.error?.message || `取消失败（HTTP ${res.status}）`);
          }
          setCheckins((prev) =>
            prev.filter((c) => !(c.poi_id === poiId && c.source === source)),
          );
        } else {
          // 存的是一份快照（名字 / 分类 / 坐标）：上游哪天没这个点了，列表里还在
          const snapshot = isWp
            ? {
                name: target.waypoint.label || `路标 ${target.waypoint.id}`,
                category: "waypoint",
                lng: target.waypoint.lng,
                lat: target.waypoint.lat,
                address: undefined,
              }
            : {
                name: target.poi.name,
                category: target.poi.category,
                lng: target.poi.lng,
                lat: target.poi.lat,
                address: target.poi.address || undefined,
              };
          const res = await fetch("/api/checkins", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ poi_id: poiId, source, ...snapshot }),
          });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error(data?.error?.message || `打卡失败（HTTP ${res.status}）`);
          }
          // 服务端是幂等的：created=false 表示早就打过（另一个标签页），以它返回的那条为准
          setCheckins((prev) =>
            prev.some((c) => c.poi_id === poiId && c.source === source) ? prev : [data.item, ...prev],
          );
        }
      } catch (e) {
        setCheckinError(e?.message || "操作失败");
      } finally {
        pendingRef.current.delete(key);
      }
    },
    [checkinKeys],
  );

  // 打卡记录变成能画在地图上的两种形状。
  // 分成两堆是必须的：路标那批得还给路标图层画（红色大 pin），
  // 塞进 POI 图层会因为 category = "waypoint" 取不到配色。
  // （这两个 memo 必须排在 canvasPois 之前 —— 依赖数组在渲染期求值，写在后面就是 TDZ 报错）

  // 取消打卡（面板列表里那个「删除」）。和收藏的删除同构，只是接口不同。
  // 打卡的撤销栈。和路标一样：进栈的是「重建这一条需要的字段」，不是 id
  // （原行已经从库里删了，id 是自增的不能复用）。
  const pushCheckinUndo = useCallback((items) => {
    if (!items.length) return;
    const next = [...checkinUndoRef.current, items].slice(-UNDO_DEPTH);
    checkinUndoRef.current = next;
    setCheckinUndoDepth(next.length);
  }, []);

  const checkinBody = (c) => ({
    poi_id: c.poi_id,
    source: c.source,
    name: c.name,
    category: c.category,
    lng: c.lng,
    lat: c.lat,
    address: c.address ?? undefined,
    // label 是「我给它起的名字」，撤销后必须原样回来，否则用户改的名白改了
    label: c.label ?? undefined,
  });

  const removeCheckin = useCallback(
    async (item) => {
      setCheckinError("");
      setCheckins((prev) => prev.filter((c) => c.id !== item.id));
      pushCheckinUndo([item]);
      try {
        const res = await fetch(`/api/checkins?id=${item.id}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error?.message || `取消失败（HTTP ${res.status}）`);
        }
        // 删的正好是正在单独预览的那一条 → 退出预览，否则框里空着
        if (preview?.kind === "checkin" && preview.item?.id === item.id) dropPreview();
      } catch (e) {
        setCheckinError(e?.message || "取消失败");
      }
    },
    [preview, dropPreview, pushCheckinUndo],
  );

  // 全部取消打卡。和路标一致：「全部删除」本身也是一步可撤销的操作（压一批进栈）
  const clearCheckins = useCallback(async () => {
    const before = checkinsRef.current;
    if (!before.length) return;
    setCheckins([]);
    pushCheckinUndo(before);
    // 预览里的东西已经被删光了，留着框没有意义
    if (preview?.kind === "checkin" || preview?.kind === "checkins") dropPreview();
    setCheckinError("");
    try {
      const res = await fetch("/api/checkins?all=1", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `全部取消失败（HTTP ${res.status}）`);
      }
    } catch (e) {
      setCheckinError(e?.message || "全部取消失败");
    }
  }, [pushCheckinUndo, preview, dropPreview]);

  const undoCheckinDelete = useCallback(async () => {
    const step = checkinUndoRef.current[checkinUndoRef.current.length - 1];
    if (!step?.length) return;
    checkinUndoRef.current = checkinUndoRef.current.slice(0, -1);
    setCheckinUndoDepth(checkinUndoRef.current.length);
    setCheckinError("");
    try {
      // 同收藏：倒序重建，恢复后顺序与删除前一致
      for (const item of [...step].reverse()) {
        const res = await fetch("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(checkinBody(item)),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error?.message || `撤销失败（HTTP ${res.status}）`);
        setCheckins((prev) =>
          prev.some((c) => c.poi_id === item.poi_id && c.source === item.source)
            ? prev
            : [data.item, ...prev],
        );
      }
    } catch (e) {
      // 撤销失败把这一步还回去，别白丢一次机会
      checkinUndoRef.current = [...checkinUndoRef.current, step].slice(-UNDO_DEPTH);
      setCheckinUndoDepth(checkinUndoRef.current.length);
      setCheckinError(e?.message || "撤销失败");
    }
  }, []);

  // 打卡列表改名。和路标改名是同一套交互（行内输入），只是接口换成了 /api/checkins。
  const startRenameCheckin = useCallback((item) => {
    renameCheckinBusyRef.current = false;
    setRenamingCheckin({ id: item.id, value: item.label || "" });
  }, []);

  const cancelRenameCheckin = useCallback(() => {
    renameCheckinBusyRef.current = true;
    setRenamingCheckin(null);
  }, []);

  const commitRenameCheckin = useCallback(async () => {
    if (renameCheckinBusyRef.current) return;
    renameCheckinBusyRef.current = true;

    const cur = renameCheckinRef.current;
    setRenamingCheckin(null);
    if (!cur) return;

    const before = checkinsRef.current.find((c) => c.id === cur.id);
    if (!before) return;

    // 清空 = 恢复上游原名（name），所以这里允许 null
    const label = cur.value.trim().slice(0, 40) || null;
    if (label === (before.label ?? null)) return;

    setCheckins((prev) => prev.map((c) => (c.id === cur.id ? { ...c, label } : c)));
    setCheckinError("");
    try {
      const res = await fetch("/api/checkins", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cur.id, label }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `改名失败（HTTP ${res.status}）`);
      }
    } catch (e) {
      setCheckins((prev) =>
        prev.map((c) => (c.id === cur.id ? { ...c, label: before.label } : c)),
      );
      setCheckinError(e?.message || "改名失败");
    }
  }, []);

  // 点弹窗里的 ☆ / ★。成功后才改本地 Set，不整页刷新。
  const toggleFavorite = useCallback(
    async (poi, source) => {
      // source 为空说明 /api/pois 还没回来（首次进页面那一两秒）。
      // 原来的写法是直接 return，用户点了按钮一点反应都没有，看起来像坏了。
      // 这里必须给出可见反馈，并且把面板打开 —— 面板贴着地图右上角，
      // 提示在面板底部那一条，能保证出现在视野里（底部概况行可能要滚动才看得到）。
      if (!source) {
        setFavError("数据还没加载完，稍等一下再点收藏");
        setFavOpen(true);
        return;
      }

      const key = `${source}:${poi.id}`;
      if (pendingRef.current.has(key)) return;
      pendingRef.current.add(key);
      setFavError("");

      try {
        if (favoriteKeys.has(key)) {
          const query = `poi_id=${encodeURIComponent(poi.id)}&source=${encodeURIComponent(source)}`;
          const res = await fetch(`/api/favorites?${query}`, { method: "DELETE" });
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            throw new Error(data?.error?.message || `删除失败（HTTP ${res.status}）`);
          }
          setFavorites((prev) => prev.filter((f) => !(f.poi_id === poi.id && f.source === source)));
        } else {
          const res = await fetch("/api/favorites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // 坐标和名字都要带上：收藏存的是一份快照，上游哪天没这个点了列表还能显示
            body: JSON.stringify({
              poi_id: poi.id,
              source,
              name: poi.name,
              category: poi.category,
              lng: poi.lng,
              lat: poi.lat,
              address: poi.address || undefined,
            }),
          });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error(data?.error?.message || `收藏失败（HTTP ${res.status}）`);
          }
          // 服务端是幂等的：created=false 表示早就收过（另一个标签页），以它返回的那条为准
          setFavorites((prev) =>
            prev.some((f) => f.poi_id === poi.id && f.source === source)
              ? prev
              : [data.item, ...prev],
          );
        }
      } catch (e) {
        setFavError(e?.message || "操作失败");
      } finally {
        pendingRef.current.delete(key);
      }
    },
    [favoriteKeys],
  );

  // ── 路标（需求 6 / 7）────────────────────────────────────────
  //
  // 数据分两处存，这是需求明确要的：
  //   路标本身 → 数据库（刷新后还在）
  //   撤销栈   → 这里的 undoRef，纯内存（刷新即清空，不能接着撤刷新前的事）

  const waypointsRef = useRef(waypoints);
  useEffect(() => {
    waypointsRef.current = waypoints;
  }, [waypoints]);

  // 改名的输入框内容也要给「提交」那个回调读到（它的依赖是空数组，拿不到最新的 state）
  const renamingRef = useRef(renaming);
  useEffect(() => {
    renamingRef.current = renaming;
  }, [renaming]);

  // 进页面拉一次
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/waypoints");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setWaypoints(Array.isArray(data.items) ? data.items : []);
      } catch {
        // 路标拉不到不该影响看地图，静默失败
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 入口位置不再需要挂载点：页头就在这个组件里（见下面的 JSX）

  // 撤销栈：**一步 = 一组路标**（不是一条）。
  //
  // 单删一步是 [1 个]，「全部删除」一步是 [当时所有 N 个]。
  // 这样"全部删除"也是可撤销的一次操作，而栈深度仍然是需求 7 的 3 步。
  const pushUndo = useCallback((items) => {
    if (!items.length) return;
    const next = [...undoRef.current, items].slice(-UNDO_DEPTH);
    undoRef.current = next;
    setUndoDepth(next.length);
  }, []);

  const addWaypoint = useCallback(async (lng, lat) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    setWpError("");
    try {
      const res = await fetch("/api/waypoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lng, lat, label: `路标 ${waypointsRef.current.length + 1}` }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || `放置失败（HTTP ${res.status}）`);
      setWaypoints((prev) => [...prev, data.item]);
    } catch (e) {
      setWpError(e?.message || "放置失败");
    }
  }, []);

  const moveWaypoint = useCallback(async (id, lng, lat) => {
    // 先改本地：拖动松手那一下不能弹回原位再跳过去
    setWaypoints((prev) => prev.map((w) => (w.id === id ? { ...w, lng, lat } : w)));
    setWpError("");
    try {
      const res = await fetch("/api/waypoints", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, lng, lat }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `保存位置失败（HTTP ${res.status}）`);
      }
    } catch (e) {
      setWpError(e?.message || "保存位置失败");
    }
  }, []);

  // ── 路标改名（2026-10-29 新增）────────────────────────────────
  //
  // 交互是一行内联编辑：点 ✎ → 名字那行变成输入框 → 回车 / ✓ / 点别处保存，Esc 取消。
  // 不用 window.prompt：它会把地图整个冻住，而且原生弹窗在移动端长得像报错。
  const startRename = useCallback((wp) => {
    // 打开一次就清一次守卫。见下面 commitRename 的说明 —— 守卫只能在这里复位，
    // 用 setTimeout 复位会和「失焦比卸载晚一帧」的时序打架。
    renameBusyRef.current = false;
    setRenaming({ id: wp.id, value: wp.label || "" });
  }, []);

  const cancelRename = useCallback(() => {
    renameBusyRef.current = true; // 让随后那一下 blur 什么都不做
    setRenaming(null);
  }, []);

  const commitRename = useCallback(async () => {
    if (renameBusyRef.current) return;
    renameBusyRef.current = true;

    const cur = renamingRef.current;
    setRenaming(null);
    if (!cur) return;

    const idx = waypointsRef.current.findIndex((w) => w.id === cur.id);
    const before = waypointsRef.current[idx];
    if (!before) return;

    // 清空就回到默认名字（「路标 N」），而不是留个空白行 —— 列表里有一行没名字很难点。
    const label = cur.value.trim().slice(0, 40) || `路标 ${idx + 1}`;
    if (label === before.label) return; // 没改就别发请求

    setWaypoints((prev) => prev.map((w) => (w.id === cur.id ? { ...w, label } : w)));
    setWpError("");
    try {
      const res = await fetch("/api/waypoints", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cur.id, label }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `改名失败（HTTP ${res.status}）`);
      }
    } catch (e) {
      // 存不上就把名字退回去，别让界面上挂着一个库里没有的名字
      setWaypoints((prev) =>
        prev.map((w) => (w.id === cur.id ? { ...w, label: before.label } : w)),
      );
      setWpError(e?.message || "改名失败");
    }
  }, []);

  const deleteWaypoint = useCallback(
    async (id) => {
      const target = waypointsRef.current.find((w) => w.id === id);
      setWaypoints((prev) => prev.filter((w) => w.id !== id));
      // 进撤销栈的是「坐标 + 名字」，不是 id：撤销时重新创建一条，
      // 因为原来的行已经从库里删了，id 是自增的、不能复用。
      if (target) pushUndo([{ lng: target.lng, lat: target.lat, label: target.label }]);
      if (preview?.kind === "waypoint" && preview.wp?.id === id) dropPreview();
      setWpError("");
      try {
        const res = await fetch(`/api/waypoints?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error?.message || `删除失败（HTTP ${res.status}）`);
        }
      } catch (e) {
        setWpError(e?.message || "删除失败");
      }
    },
    [pushUndo, preview, dropPreview],
  );

  const clearWaypoints = useCallback(async () => {
    const before = waypointsRef.current.map((w) => ({ lng: w.lng, lat: w.lat, label: w.label }));
    setWaypoints([]);
    // 全部删除也算一步撤销：把删掉的那一批整体压进栈（不是清空栈）
    pushUndo(before);
    setWpError("");
    try {
      const res = await fetch("/api/waypoints?all=1", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `全部删除失败（HTTP ${res.status}）`);
      }
    } catch (e) {
      setWpError(e?.message || "全部删除失败");
    }
  }, [pushUndo]);

  const undoDelete = useCallback(async () => {
    const step = undoRef.current[undoRef.current.length - 1];
    if (!step?.length) return;
    undoRef.current = undoRef.current.slice(0, -1);
    setUndoDepth(undoRef.current.length);
    setWpError("");
    try {
      // 一步里可能有多个（全部删除），逐个重建；顺序按原来列表走，名字也对得上
      for (const item of step) {
        const res = await fetch("/api/waypoints", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error?.message || `撤销失败（HTTP ${res.status}）`);
        setWaypoints((prev) => [...prev, data.item]);
      }
    } catch (e) {
      // 撤销失败就把这一步还回栈里，别白丢一次机会
      undoRef.current = [...undoRef.current, step].slice(-UNDO_DEPTH);
      setUndoDepth(undoRef.current.length);
      setWpError(e?.message || "撤销失败");
    }
  }, []);

  // ── 预览的进出场动画（2026-10-29 第三轮）──────────────────────
  //
  // 进入：窗口里的那一行（或者窗口本身）先变成一个淡蓝色小框，再"飞"到地图上贴住地图的四边，
  //       贴合完成后框内顶部中央出现两个字：「特定节点展示 ×」，点 × 退出。
  // 退出：框淡掉、地图 easeTo 回刚进页面时的视野（resetKey +1），筛选恢复成全选。
  //
  // 为什么用 fixed 定位 + CSS transition 而不是给地图加遮罩：
  //   框要能盖在窗口和地图之间的任何位置，只有 fixed 能跨容器定位；
  //   尺寸/位置四个属性一起过渡，才有一块"框被拉大"的连续感（不是淡入淡出）。

  const clearFrameTimers = useCallback(() => {
    frameTimers.current.forEach(clearTimeout);
    frameTimers.current = [];
  }, []);

  useEffect(() => clearFrameTimers, [clearFrameTimers]);

  const openPreview = useCallback(
    (next, srcEl) => {
      const mapEl = mapWrapRef.current;
      if (!mapEl) return;
      clearFrameTimers();

      // 已经处在「特定节点展示」里（框已经贴在地图边上）→ 只换数据，不再放一遍生成动画，
      // 而且窗口**保持打开**：用户就是要在窗口里连着点几个节点，收起来反而每次都要重开。
      // 框老老实实待在地图边缘，只有框里的内容在换 —— 每次都从窗口飞一遍会让人以为地图在抖。
      setPreview(next);
      if (frame?.label) return;
      setFavOpen(false);
      setWpOpen(false);

      const to = mapEl.getBoundingClientRect();
      // 起始矩形：优先用「整个窗口」——用户看到的是"窗口退化成一个框飞向地图"，
      // 退而求其次才用被点的那一行。
      //
      // 也接受一个**裸矩形** {left, top, width, height}：地图上那些 pin 不是 DOM 元素，
      // 点它们的时候没有窗口可量，只能由 MapCanvas 用 projectToContainer 算出屏幕矩形传进来。
      // 于是"点自己放的路标"就是「框从这枚 pin 身上长出来，再飞向地图四边」。
      const origin =
        srcEl && typeof srcEl.getBoundingClientRect === "function"
          ? (srcEl.closest?.("[data-preview-source]") ?? srcEl)
          : null;
      const from =
        origin?.getBoundingClientRect?.() ??
        (srcEl && typeof srcEl.left === "number" ? srcEl : to);

      setFrame({
        style: { left: from.left, top: from.top, width: from.width, height: from.height },
        animate: false,
        visible: true,
        label: false,
        fogOut: false,
      });

      // 两帧之后再改目标尺寸，否则浏览器会把"初始态"和"目标态"合成一次，动画不播
      frameTimers.current.push(
        setTimeout(() => {
          setFrame((f) =>
            f
              ? {
                  ...f,
                  style: { left: to.left, top: to.top, width: to.width, height: to.height },
                  animate: true,
                }
              : f,
          );
        }, 30),
      );
      frameTimers.current.push(
        setTimeout(() => setFrame((f) => (f ? { ...f, label: true } : f)), 520),
      );
    },
    [clearFrameTimers, frame],
  );

  const exitPreview = useCallback(() => {
    clearFrameTimers();

    // 退场的三段接力（用户需求：蓝雾向四边散去、框内逐渐变亮）：
    //   ① 0ms   雾气开始往四边散（scale 1 → 1.18 + blur + 淡出，620ms）
    //   ② 180ms 边框才开始淡（错开一点，否则"雾还在散，框先没了"，像是画面被裁掉一块）
    //   ③ 760ms 整块从 DOM 摘掉
    // 数据恢复放在 0ms：节点立刻回来，地图同时 easeTo 回初始视野。
    // 雾气散开的 620ms 正好盖住地图缩回去的那段动画 —— 亮起来的过程就是"雾退了"。
    setFrame((f) => (f ? { ...f, label: false, fogOut: true } : f));
    setPreview(null);
    setSelectedPoi(null);
    setSelectedIds(FILTER_TYPE_IDS); // 恢复成"全部节点"
    setResetKey((k) => k + 1); // 地图 easeTo 回初始视野

    frameTimers.current.push(
      setTimeout(() => setFrame((f) => (f ? { ...f, visible: false } : f)), 180),
    );
    frameTimers.current.push(setTimeout(() => setFrame(null), 760));
  }, [clearFrameTimers]);

  // ESC 也能退出预览：标签上那个 × 太小，键盘党不想为此去找鼠标。
  // 只在"框已经贴好"的时候接管 ESC（正在飞的 500ms 里不拦，避免误触）。
  useEffect(() => {
    if (!frame?.label) return;
    const onKey = (e) => {
      if (e.key === "Escape") exitPreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frame?.label, exitPreview]);

  // 边框是 fixed 定位的，页面一滚它就会和地图脱开。
  // 滚动/改窗口大小时跟着地图重新贴一次；这一步要关掉过渡（animate: false），
  // 否则每个滚动事件都播一次 460ms 动画，边框会像橡皮筋一样追不上。
  const frameOn = frame !== null;
  useEffect(() => {
    if (!frameOn) return;
    const sync = () => {
      const el = mapWrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setFrame((f) =>
        f
          ? {
              ...f,
              animate: false,
              style: { left: r.left, top: r.top, width: r.width, height: r.height },
            }
          : f,
      );
    };
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [frameOn]);

  // 收藏面板里的「删除」按钮（2026-10-29 新增）。
  // 和弹窗里那个 ★ 走同一个接口，只是入口在列表里 —— 用户不用先定位过去再取消收藏。
  // 参数是「收藏列表那一行」，字段是 poi_id / source（不是 POI 的 id / dataSource）。
  // 收藏的撤销栈。口径和路标完全一致：一步 = 一组，深度 3，只在前端内存里。
  const pushFavUndo = useCallback((items) => {
    if (!items.length) return;
    const next = [...favUndoRef.current, items].slice(-UNDO_DEPTH);
    favUndoRef.current = next;
    setFavUndoDepth(next.length);
  }, []);

  // 重建一条收藏要用的字段。注意接口要的是 source + poi_id（不是 POI 的 id + dataSource），
  // 而且坐标/名字都是当时的快照 —— 上游后来没这个点了，撤销回来也还能看见。
  const favoriteBody = (f) => ({
    poi_id: f.poi_id,
    source: f.source,
    name: f.name,
    category: f.category,
    lng: f.lng,
    lat: f.lat,
    address: f.address ?? undefined,
    note: f.note ?? undefined,
  });

  const removeFavorite = useCallback(async (item) => {
    setFavError("");
    const query = `poi_id=${encodeURIComponent(item.poi_id)}&source=${encodeURIComponent(item.source)}`;
    // 先压栈再删：万一请求失败，撤销栈里多一条不影响（撤销时幂等 POST 会还回原样）
    pushFavUndo([item]);
    try {
      const res = await fetch(`/api/favorites?${query}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `删除失败（HTTP ${res.status}）`);
      }
      setFavorites((prev) => prev.filter((f) => !(f.poi_id === item.poi_id && f.source === item.source)));
      // 两种情况要顺手退出预览：
      //   ① 删的就是正在单独预览的那个点   ② 预览"全部收藏"时删掉最后一条（否则框里一个点都没有）
      const previewedOne = preview?.kind === "poi" && preview.poi?.id === item.poi_id;
      const previewedAll = preview?.kind === "favorites" && favorites.length <= 1;
      if (previewedOne || previewedAll) dropPreview();
      setSelectedPoi((cur) => (cur && cur.id === item.poi_id ? null : cur));
    } catch (e) {
      setFavError(e?.message || "删除失败");
    }
  }, [preview, favorites.length, dropPreview, pushFavUndo]);

  // 全部取消收藏。和路标一致：这一下本身也是一步可撤销的操作（把删掉的一整批压进栈）
  const clearFavorites = useCallback(async () => {
    const before = favoritesRef.current;
    if (!before.length) return;
    setFavorites([]);
    pushFavUndo(before);
    // 收藏都没了，预览里那个点也没了
    if (preview?.kind === "favorites" || preview?.kind === "poi") {
      const fromFavorite = before.some((f) => f.poi_id === preview?.poi?.id);
      if (preview?.kind === "favorites" || fromFavorite) dropPreview();
    }
    setSelectedPoi(null);
    setFavError("");
    try {
      const res = await fetch("/api/favorites?all=1", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `全部删除失败（HTTP ${res.status}）`);
      }
    } catch (e) {
      setFavError(e?.message || "全部删除失败");
    }
  }, [pushFavUndo, preview, dropPreview]);

  const undoFavoriteDelete = useCallback(async () => {
    const step = favUndoRef.current[favUndoRef.current.length - 1];
    if (!step?.length) return;
    favUndoRef.current = favUndoRef.current.slice(0, -1);
    setFavUndoDepth(favUndoRef.current.length);
    setFavError("");
    try {
      // 列表是 created_at 倒序（新的在上），撤销时得**从旧的往回建**，
      // 重建出来的时间戳顺序才和原来一致，恢复后那一行还在原来的位置。
      for (const item of [...step].reverse()) {
        const res = await fetch("/api/favorites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(favoriteBody(item)),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error?.message || `撤销失败（HTTP ${res.status}）`);
        setFavorites((prev) =>
          prev.some((f) => f.poi_id === item.poi_id && f.source === item.source)
            ? prev
            : [data.item, ...prev],
        );
      }
    } catch (e) {
      favUndoRef.current = [...favUndoRef.current, step].slice(-UNDO_DEPTH);
      setFavUndoDepth(favUndoRef.current.length);
      setFavError(e?.message || "撤销失败");
    }
  }, []);

  // 单个收藏点预览：飞过去 + 只画它 + 播边框动画
  const focusFavorite = useCallback(
    (item, srcEl) => {
      // 先在已加载的点里找同一个人。收藏表存的只是一份「坐标 + 名字 + 分类」快照，
      // 存不下 kind（地铁 / 公交）和 lines（几号线、几路）—— 不补这一步，
      // 从收藏点过去，弹窗会写成「交通站」、线路那行也不出来（需求 3）。
      // 用 id 对齐就够了：id 自带来源前缀（osm:node/…），mock 的 id 是另一套，不会互撞。
      const live = pois.find((p) => p.id === item.poi_id);
      const poi = {
        ...live,
        id: item.poi_id,
        name: item.name,
        category: item.category,
        lng: item.lng,
        lat: item.lat,
        // 收藏时存下来的地址优先（上游后来删了这条也能看到），没有再退回实时数据
        address: item.address || live?.address,
        // 收藏表里只有坐标，距离要现算（弹窗里要显示"距离多远、走多久"）
        distance: Math.round(distanceMeters(origin, item)),
      };
      setFocusPoi({ lng: item.lng, lat: item.lat });
      setSelectedPoi(poi);
      openPreview({ kind: "poi", poi }, srcEl);
    },
    [origin, pois, openPreview],
  );

  // 单个路标预览：飞过去 + 只画这一个路标（其他节点全部隐藏）
  const focusWaypoint = useCallback(
    (wp, srcEl) => {
      setFocusPoi({ lng: wp.lng, lat: wp.lat });
      openPreview({ kind: "waypoint", wp }, srcEl);
    },
    [openPreview],
  );

  // 「显示全部收藏 / 全部路标」：把视野撑到能装下这些点
  const fitFocus = useCallback((items) => {
    if (!items.length) return;
    const lng = items.reduce((s, i) => s + i.lng, 0) / items.length;
    const lat = items.reduce((s, i) => s + i.lat, 0) / items.length;
    // 半径取"离中心最远的那个"再留 30% 余量，交给 MapCanvas 按可视尺寸换算缩放级别
    const spread = Math.max(
      200,
      ...items.map((i) => distanceMeters({ lng, lat }, i)),
    ) * 1.3;
    setFocusPoi({ lng, lat, radius: spread });
  }, []);

  const previewAllFavorites = useCallback(
    (srcEl) => {
      if (!favorites.length) return;
      fitFocus(favoritePois);
      openPreview({ kind: "favorites" }, srcEl);
    },
    [favorites.length, favoritePois, fitFocus, openPreview],
  );

  const previewAllWaypoints = useCallback(
    (srcEl) => {
      if (!waypoints.length) return;
      fitFocus(waypoints);
      openPreview({ kind: "waypoints" }, srcEl);
    },
    [waypoints, fitFocus, openPreview],
  );

  // 单个打卡点预览：飞过去 + 只画它（POI 或路标，看它当初打的是哪种卡）
  const focusCheckin = useCallback(
    (item, srcEl) => {
      if (item.source === "waypoint") {
        const id = Number(String(item.poi_id).replace(/^wp:/, ""));
        const wp = waypoints.find((w) => w.id === id);
        // 路标被删了就没得飞 —— 列表里那行还在（能改名能删），只是点不进去
        if (!wp) return;
        setFocusPoi({ lng: wp.lng, lat: wp.lat });
      } else {
        setFocusPoi({ lng: item.lng, lat: item.lat });
      }
      openPreview({ kind: "checkin", item }, srcEl);
    },
    [waypoints, openPreview],
  );

  // 「显示全部打卡」：POI 和路标混着算，视野要装下两批点
  const previewAllCheckins = useCallback(
    (srcEl) => {
      const all = [...checkinPois, ...checkinWaypoints];
      if (!all.length) return;
      fitFocus(all);
      openPreview({ kind: "checkins" }, srcEl);
    },
    [checkinPois, checkinWaypoints, fitFocus, openPreview],
  );

  return (
    <div>
      {/* 页头：标题 + 右上角那两个按钮。
          原来在 page.js（服务端组件）里，但「路标」要用 MapView 的状态，
          为了一行按钮再加个 portal 不划算，索性整行搬进来。 */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-[#726fab]">地图</h1>

        <div className="flex items-center gap-3">
          {/* 需求 6：路标入口，就在「返回首页」左边 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setWpOpen((open) => !open);
                if (wpOpen) setWpMode(false);
              }}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors"
              style={
                wpOpen || wpMode
                  ? { backgroundColor: PRIMARY, borderColor: PRIMARY, color: "#fff" }
                  : { borderColor: "#d4d4d8", backgroundColor: "#fff", color: "#52525b" }
              }
            >
              <span aria-hidden="true">🚩</span>
              路标{waypoints.length > 0 && ` (${waypoints.length})`}
            </button>

            {wpOpen && (
              <div data-preview-source className="absolute right-0 top-full z-[2100] mt-2 w-[18.5rem] rounded-[14px] border border-zinc-200 bg-white/97 p-3 text-left shadow-lg">
                <p className="text-[11.5px] leading-5 text-zinc-500">
                  打开「放置」后点地图任意位置就能放一个路标；路标可以拖动调整位置；
                  点一下已有的路标可以删除它。下面每一条也能点进去单独看，点 ✎ 能改名。
                </p>

                <button
                  type="button"
                  onClick={() => {
                    // 进入放置模式就收起这个面板：它贴着地图右上角，开着会一直挡着图
                    // （用户反馈「上面被挡住啥也看不清」就是它 + 顶部那条提示条造成的）
                    setWpMode((m) => !m);
                    setWpOpen(false);
                  }}
                  className="mt-2 w-full rounded-lg border px-3 py-1.5 text-sm transition-colors"
                  style={
                    wpMode
                      ? { backgroundColor: PRIMARY, borderColor: PRIMARY, color: "#fff" }
                      : { borderColor: "#d4d4d8", backgroundColor: "#fff", color: "#52525b" }
                  }
                >
                  {wpMode ? "● 放置中（再点一次停止）" : "放置路标"}
                </button>

                {/* 全部路标的清单（2026-10-29 新增）：和「我的收藏」一样，
                    能看全部、能点进去预览、能一条一条删。 */}
                <button
                  type="button"
                  onClick={(e) => previewAllWaypoints(e.currentTarget)}
                  disabled={waypoints.length === 0}
                  className="mt-2 w-full rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-1.5 text-left text-[12px] text-sky-800 transition-colors hover:bg-sky-100/70 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  只显示全部路标（{waypoints.length}）
                  <span className="ml-1 text-[11px] text-sky-600/80">暂时隐藏其他节点</span>
                </button>

                <div className="mt-2 max-h-[30vh] overflow-y-auto rounded-lg border border-zinc-100">
                  {waypoints.length === 0 ? (
                    <p className="px-2 py-4 text-center text-[11.5px] leading-5 text-zinc-400">
                      还没有路标
                    </p>
                  ) : (
                    waypoints.map((wp) => (
                      <div
                        key={wp.id}
                        className="flex items-center gap-1 border-b border-zinc-50 pr-1 last:border-b-0 hover:bg-zinc-50"
                      >
                        {renaming?.id === wp.id ? (
                          // 改名中：名字那行变成输入框，下面的坐标行换成快捷键提示
                          <div className="flex min-w-0 flex-1 items-start gap-1.5 px-2 py-1.5">
                            <span aria-hidden="true" className="mt-0.5 text-[11px]">🚩</span>
                            <div className="min-w-0 flex-1">
                              <input
                                autoFocus
                                value={renaming.value}
                                maxLength={40}
                                placeholder="给这个路标起个名字"
                                aria-label="路标名字"
                                onChange={(e) =>
                                  setRenaming({ id: wp.id, value: e.target.value })
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    commitRename();
                                  } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    cancelRename();
                                  }
                                }}
                                // 点别处也算保存：用户改了字直接去点地图，不该丢改动
                                onBlur={commitRename}
                                className="w-full rounded border border-sky-300 bg-white px-1.5 py-0.5 text-[12px] leading-4 text-zinc-800 outline-none focus:border-sky-500"
                              />
                              <span className="mt-0.5 block truncate text-[10px] leading-4 text-zinc-400">
                                回车保存 · Esc 取消
                              </span>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => focusWaypoint(wp, e.currentTarget)}
                            title="点一下只看这个路标"
                            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
                          >
                            <span aria-hidden="true" className="text-[11px]">🚩</span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] leading-4 text-zinc-800">
                                {wp.label || "路标"}
                              </span>
                              <span className="block truncate text-[10.5px] leading-4 text-zinc-400">
                                {wp.lng.toFixed(5)}, {wp.lat.toFixed(5)}
                              </span>
                            </span>
                          </button>
                        )}

                        {renaming?.id === wp.id ? (
                          <>
                            {/* 这两个按钮都 down 掉 mousedown：不拦的话，按下的一瞬间
                                输入框先失焦（onBlur 保存），click 才轮到「取消」——
                                点 ✕ 反而变成了保存。 */}
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={commitRename}
                              title="保存名字（回车）"
                              aria-label="保存名字"
                              className="flex-none rounded-md border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700 transition-colors hover:bg-sky-100"
                            >
                              ✓
                            </button>
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={cancelRename}
                              title="取消改名（Esc）"
                              aria-label="取消改名"
                              className="flex-none rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-100"
                            >
                              ✕
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => startRename(wp)}
                              title="给这个路标改名"
                              aria-label={`给路标 ${wp.label || ""} 改名`}
                              className="flex-none rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:border-sky-200 hover:bg-sky-50 hover:text-sky-600"
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteWaypoint(wp.id)}
                              title="删除这个路标"
                              aria-label={`删除路标 ${wp.label || ""}`}
                              className="flex-none rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                            >
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={undoDelete}
                    disabled={undoDepth === 0}
                    className="flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-600 transition-colors hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    撤销删除{undoDepth > 0 ? `（${undoDepth}）` : ""}
                  </button>
                  <button
                    type="button"
                    onClick={clearWaypoints}
                    disabled={waypoints.length === 0}
                    className="flex-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 transition-colors hover:border-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    全部删除
                  </button>
                </div>

                <p className="mt-2 text-[11px] leading-4 text-zinc-400">
                  路标存在数据库里，刷新后仍然在；「全部删除」也能撤销，撤销最多 3 步，刷新后失效。
                </p>

                {wpError && (
                  <p className="mt-2 rounded bg-red-50 px-2 py-1 text-[11px] leading-4 text-red-600">
                    {wpError}
                  </p>
                )}
              </div>
            )}
          </div>

          <Link href="/" className="text-sm text-zinc-500 hover:text-[#726fab]">
            返回首页
          </Link>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-sm text-zinc-500">起点</span>
        {ORIGINS.map((o) => {
          const selected = originId === o.id;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => setOriginId(o.id)}
              className="rounded-lg border px-3 py-1.5 text-sm transition-colors"
              style={
                selected
                  ? { backgroundColor: PRIMARY, borderColor: PRIMARY, color: "#fff" }
                  : { borderColor: "#d4d4d8", backgroundColor: "#fff", color: "#52525b" }
              }
            >
              {o.label}
            </button>
          );
        })}
        <span className="ml-1 text-xs text-zinc-400">北京航空航天大学</span>

        {/* 右上角两个入口：收藏在上、打卡在下（用户要求「我的收藏下方设置我的打卡」）。
            两个面板都贴在地图右上角、位置完全重合，所以这里做了互斥：开一个就关掉另一个。
            不互斥的话，后开的那个会把先开的整个盖住，看起来像"点了没反应"。 */}
        <div className="ml-auto flex flex-col items-stretch gap-1.5">
          <button
            type="button"
            onClick={() => {
              setFavOpen((open) => !open);
              setCheckinOpen(false);
            }}
            className="rounded-lg border px-3 py-1.5 text-sm transition-colors"
            style={
              favOpen
                ? { backgroundColor: PRIMARY, borderColor: PRIMARY, color: "#fff" }
                : { borderColor: "#d4d4d8", backgroundColor: "#fff", color: "#52525b" }
            }
          >
            我的收藏 ({favorites.length})
          </button>

          <button
            type="button"
            onClick={() => {
              setCheckinOpen((open) => !open);
              setFavOpen(false);
            }}
            className="rounded-lg border px-3 py-1.5 text-sm transition-colors"
            style={
              checkinOpen
                ? { backgroundColor: "#e0a800", borderColor: "#e0a800", color: "#fff" }
                : { borderColor: "#d4d4d8", backgroundColor: "#fff", color: "#52525b" }
            }
          >
            我的打卡 ({checkins.length})
          </button>
        </div>
      </div>

      {/* 上游挂了的时候后端会退回示例数据。这条必须放在地图**上方** ——
          放到底部要滚动才看得到，用户会直接把示例数据当成真实地点。 */}
      {dataSource === "mock-fallback" && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-5 text-amber-800">
          <b>当前显示的是示例数据，不是真实地点。</b>
          {notice && <span className="ml-1">原因：{notice}</span>}
        </div>
      )}

      {/* 地图容器高度写在这里，地图组件只负责填满。
          地图要一直挂着：切筛选时不能卸载重挂，否则等于重建地图、视野会丢。
          ref 是给预览边框动画用的 —— 框要"贴合"的就是这块矩形。 */}
      <div
        ref={mapWrapRef}
        className="relative h-[64vh] min-h-[420px] w-full overflow-hidden rounded-[18px] bg-zinc-100"
      >
        <MapCanvas
          center={origin}
          radius={radius}
          reach={reach}
          // 画什么点由上层算好（普通筛选 / 只看一个 / 只看全部收藏 / 只留路标）
          pois={canvasPois}
          modeId={modeId}
          dataSource={dataSource}
          favoriteKeys={favoriteKeys}
          onToggleFavorite={toggleFavorite}
          checkinKeys={checkinKeys}
          onToggleCheckin={toggleCheckin}
          focusPoi={focusPoi}
          resetKey={resetKey}
          hidden={canvasHidden}
          selectedPoi={canvasSinglePoi}
          onSelect={setSelectedPoi}
          waypoints={canvasWaypoints}
          waypointMode={wpMode}
          onAddWaypoint={addWaypoint}
          onMoveWaypoint={moveWaypoint}
          onDeleteWaypoint={deleteWaypoint}
          // 点地图上自己放的路标 → 同样走聚焦（缩放 + 边框从 pin 长出来飞向地图四边）
          onFocusWaypoint={focusWaypoint}
          previewing={previewing}
          onVisibleCount={setVisibleCount}
        />

        {/* 路标放置模式的小提示。
            原来是贴顶的一条通栏紫条（inset-x-3 top-3），把地图上沿整片盖住了 —— 
            上面还说这片看不清。改成底部居中的小胶囊：只在需要看的时候露一眼，
            而且底部是空白区域，不会挡住任何标记。 */}
        {wpMode && (
          <div className="absolute inset-x-0 bottom-3 z-[1000] flex justify-center px-3">
            <span className="flex items-center gap-2 rounded-full bg-[#726fab]/95 py-1.5 pl-3.5 pr-1.5 text-[11.5px] leading-5 text-white shadow-sm">
              放置中：点地图任意位置放一个路标，放完可以拖动它
              {/* 面板在进入放置时已经收起，所以这里必须留一个能退出的地方 */}
              <button
                type="button"
                onClick={() => setWpMode(false)}
                className="rounded-full bg-white/20 px-2 py-0.5 text-[11px] transition-colors hover:bg-white/35"
              >
                停止放置
              </button>
            </span>
          </div>
        )}

        {/* 左上角常驻读数：切换时间 / 出行方式时，这里一定跟着变。
            地图上的圆可能大到出画外（骑行一小时 15km），光看圆看不出变化，
            所以把「能到多远」和「数据到哪」这两个数字钉在图上。 */}
        <div className="pointer-events-none absolute left-3 top-3 z-[1000] rounded-[10px] bg-white/95 px-3 py-1.5 text-[11.5px] leading-5 text-zinc-600 shadow-sm ring-1 ring-zinc-200">
          <b className="text-zinc-800">
            {modeById(modeId).label} {timeById(timeId).label}
          </b>
          <span className="mx-1.5 text-zinc-300">|</span>
          能到 {formatDistance(reach)}
          <span className="mx-1.5 text-zinc-300">·</span>
          数据覆盖 {formatDistance(radius)}
        </div>

        {/* 可达圈比数据圈大时，灰圈外面确实是空的。不说清楚就会被当成筛选失效。
            放置模式时往上挪 12，给底部那个小胶囊腾位置（两者都在 bottom）。 */}
        {clipped && (
          <div
            className={`pointer-events-none absolute inset-x-3 z-[1000] rounded-[10px] bg-amber-50/95 px-3 py-2 text-[11.5px] leading-5 text-amber-800 shadow-sm ring-1 ring-amber-200 ${
              wpMode ? "bottom-12" : "bottom-3"
            }`}
          >
            紫色圈是{modeById(modeId).label}
            {timeById(timeId).label}能到的范围（{formatDistance(reach)}），灰色圈是现有地点数据的覆盖范围（
            {formatDistance(radius)}）。灰圈外面没有地点数据，不是没画出来。
          </div>
        )}

        {loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/40">
            <p className="rounded-full bg-white/90 px-4 py-1.5 text-sm text-zinc-600 shadow-sm">
              加载中…
            </p>
          </div>
        )}

        {error && !loading && (
          <div className="absolute inset-x-3 top-3 rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700 shadow">
            接口请求失败：{error}
            <span className="ml-2 text-xs text-red-500">（切换一下时间可以重试）</span>
          </div>
        )}

        {/* 收藏浮层。放在地图容器里是为了贴着地图盖上去。
            z-index 必须给到 2000：TMap 的控件容器实测是 z-index:1000（旋转按钮就在里面），
            写成 z-30/z-999 时「关闭」按钮会被它盖住、点不到。 */}
        {favOpen && (
          <div data-preview-source className="absolute right-3 top-3 z-[2000] w-[17rem] overflow-hidden rounded-[14px] border border-zinc-200 bg-white/95 shadow-lg backdrop-blur">
            <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
              <span className="text-sm font-medium text-zinc-800">
                我的收藏 ({favorites.length})
              </span>
              <button
                type="button"
                onClick={() => setFavOpen(false)}
                className="text-xs text-zinc-400 hover:text-zinc-700"
              >
                关闭
              </button>
            </div>

            {/* 「只看全部收藏」：把地图切成"只显示我收藏的点"，其他节点全部隐藏。
                和点某一行的区别是范围和视野 —— 这里会把视野撑到能装下所有收藏。 */}
            <button
              type="button"
              onClick={(e) => previewAllFavorites(e.currentTarget)}
              disabled={favorites.length === 0}
              className="w-full border-b border-zinc-100 bg-sky-50/60 px-3 py-2 text-left text-[12px] text-sky-800 transition-colors hover:bg-sky-100/70 disabled:cursor-not-allowed disabled:opacity-45"
            >
              只显示全部收藏（{favorites.length}）
              <span className="ml-1 text-[11px] text-sky-600/80">暂时隐藏其他节点</span>
            </button>

            <div className="max-h-[60vh] overflow-y-auto">
              {favorites.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs leading-6 text-zinc-400">
                  还没有收藏，点地图上的标记试试
                </p>
              ) : (
                favorites.map((item) => (
                  // 一行拆成「定位」+「删除」两个按钮（2026-10-29 新增删除）。
                  // 原来整行就是一个 <button>，里面再放删除按钮会出现 <button> 套 <button>，
                  // HTML 不允许，浏览器会把里面那个提到外面去 —— 所以外层改成 div。
                  <div
                    key={item.id}
                    className="flex items-center gap-1 border-b border-zinc-50 pr-2 hover:bg-zinc-50"
                  >
                    <button
                      type="button"
                      // 点一下把地图挪过去（需求 1 的定位动画在 MapCanvas 里做），
                      // 用的是收藏时存下来的坐标快照；同时进「特定节点展示」预览
                      onClick={(e) => focusFavorite(item, e.currentTarget)}
                      className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left"
                    >
                      <span
                        className="mt-1.5 inline-block h-2 w-2 flex-none rounded-full"
                        style={{ backgroundColor: poiColor(item) }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] leading-5 text-zinc-800">
                          {item.name}
                        </span>
                        <span className="block truncate text-[11px] leading-4 text-zinc-400">
                          {categoryLabel(item.category)} · {item.address || "暂无地址"}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFavorite(item)}
                      title="取消收藏"
                      aria-label={`取消收藏 ${item.name}`}
                      className="flex-none rounded-md border border-zinc-200 px-2 py-1 text-[11.5px] text-zinc-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                    >
                      删除
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* 撤销 / 全部删除（2026-10-29）。和路标面板那一组按钮一模一样：
                一步 = 一组，深度 3，只在前端内存里，刷新即失效。 */}
            <div className="flex gap-2 border-t border-zinc-100 px-2 py-2">
              <button
                type="button"
                onClick={undoFavoriteDelete}
                disabled={favUndoDepth === 0}
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-600 transition-colors hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                撤销删除{favUndoDepth > 0 ? `（${favUndoDepth}）` : ""}
              </button>
              <button
                type="button"
                onClick={clearFavorites}
                disabled={favorites.length === 0}
                className="flex-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 transition-colors hover:border-red-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                全部删除
              </button>
            </div>

            <p className="px-3 pb-2 text-[11px] leading-4 text-zinc-400">
              收藏存在数据库里，刷新后仍然在；「全部删除」也能撤销，撤销最多 3 步，刷新后失效。
            </p>

            {favError && (
              <p className="border-t border-zinc-100 bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-600">
                {favError}
              </p>
            )}
          </div>
        )}

        {/* 打卡浮层（2026-10-29）。和收藏同一个位置、同一个 z-index ——
            能同时存在是因为上面那个按钮做了互斥，不会两个一起出现。 */}
        {checkinOpen && (
          <div data-preview-source className="absolute right-3 top-3 z-[2000] w-[17rem] overflow-hidden rounded-[14px] border border-zinc-200 bg-white/95 shadow-lg backdrop-blur">
            <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
              <span className="text-sm font-medium text-zinc-800">
                我的打卡 ({checkins.length})
              </span>
              <button
                type="button"
                onClick={() => setCheckinOpen(false)}
                className="text-xs text-zinc-400 hover:text-zinc-700"
              >
                关闭
              </button>
            </div>

            <button
              type="button"
              onClick={(e) => previewAllCheckins(e.currentTarget)}
              disabled={checkins.length === 0}
              className="w-full border-b border-zinc-100 bg-amber-50/60 px-3 py-2 text-left text-[12px] text-amber-800 transition-colors hover:bg-amber-100/70 disabled:cursor-not-allowed disabled:opacity-45"
            >
              只显示全部打卡（{checkins.length}）
              <span className="ml-1 text-[11px] text-amber-700/80">暂时隐藏其他节点</span>
            </button>

            <div className="max-h-[60vh] overflow-y-auto">
              {checkins.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs leading-6 text-zinc-400">
                  还没有打卡，点地图上的标记，在弹窗里勾一下
                </p>
              ) : (
                checkins.map((item) => {
                  const isWp = item.source === "waypoint";
                  const shown = item.label || item.name;
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-1 border-b border-zinc-50 pr-2 hover:bg-zinc-50"
                    >
                      {renamingCheckin?.id === item.id ? (
                        <div className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2">
                          <span
                            className="mt-1.5 inline-block h-2 w-2 flex-none rounded-full"
                            style={{ backgroundColor: isWp ? "#e03131" : poiColor(item) }}
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <input
                              autoFocus
                              value={renamingCheckin.value}
                              maxLength={40}
                              placeholder={item.name}
                              aria-label="打卡名字"
                              onChange={(e) =>
                                setRenamingCheckin({ id: item.id, value: e.target.value })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitRenameCheckin();
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelRenameCheckin();
                                }
                              }}
                              onBlur={commitRenameCheckin}
                              className="w-full rounded border border-amber-300 bg-white px-1.5 py-0.5 text-[12.5px] leading-5 text-zinc-800 outline-none focus:border-amber-500"
                            />
                            <span className="mt-0.5 block truncate text-[10px] leading-4 text-zinc-400">
                              回车保存 · Esc 取消 · 清空恢复原名
                            </span>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => focusCheckin(item, e.currentTarget)}
                          className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left"
                        >
                          <span
                            className="mt-1.5 inline-block h-2 w-2 flex-none rounded-full"
                            style={{ backgroundColor: isWp ? "#e03131" : poiColor(item) }}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] leading-5 text-zinc-800">
                              {shown}
                            </span>
                            <span className="block truncate text-[11px] leading-4 text-zinc-400">
                              {isWp ? "路标" : categoryLabel(item.category)}
                              {/* 改过名就把原名带出来，不然"这到底是哪儿"就认不出了 */}
                              {item.label ? ` · 原名 ${item.name}` : ""}
                              {" · "}
                              {isWp ? "我放的" : item.address || "暂无地址"}
                            </span>
                          </span>
                        </button>
                      )}

                      {renamingCheckin?.id === item.id ? (
                        <>
                          {/* 和路标改名同理：不拦 mousedown 的话，按下的一瞬间输入框先失焦保存，
                              点 ✕ 反而变成"保存" */}
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={commitRenameCheckin}
                            title="保存名字（回车）"
                            aria-label="保存打卡名字"
                            className="flex-none rounded-md border border-amber-300 bg-amber-50 px-1.5 py-1 text-[11px] text-amber-700 transition-colors hover:bg-amber-100"
                          >
                            ✓
                          </button>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={cancelRenameCheckin}
                            title="取消改名（Esc）"
                            aria-label="取消打卡改名"
                            className="flex-none rounded-md border border-zinc-200 px-1.5 py-1 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-100"
                          >
                            ✕
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => startRenameCheckin(item)}
                            title="给这条打卡改名"
                            aria-label={`给 ${shown} 改名`}
                            className="flex-none rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:border-amber-200 hover:bg-amber-50 hover:text-amber-700"
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            onClick={() => removeCheckin(item)}
                            title="取消打卡"
                            aria-label={`取消打卡 ${shown}`}
                            className="flex-none rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex gap-2 border-t border-zinc-100 px-2 py-2">
              <button
                type="button"
                onClick={undoCheckinDelete}
                disabled={checkinUndoDepth === 0}
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-600 transition-colors hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                撤销删除{checkinUndoDepth > 0 ? `（${checkinUndoDepth}）` : ""}
              </button>
              <button
                type="button"
                onClick={clearCheckins}
                disabled={checkins.length === 0}
                className="flex-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 transition-colors hover:border-red-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                全部删除
              </button>
            </div>

            <p className="px-3 pb-2 text-[11px] leading-4 text-zinc-400">
              打卡存在数据库里，刷新后仍然在；「全部删除」也能撤销，撤销最多 3 步，刷新后失效。
            </p>

            {checkinError && (
              <p className="border-t border-zinc-100 bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-600">
                {checkinError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* 需求 5：筛选栏在地图下方。2026-10-29 起支持多选（点一个加一个、再点取消） */}
      <div className="mt-4">
        <FilterBar
          selectedIds={selectedIds}
          timeId={timeId}
          modeId={modeId}
          onToggle={toggleFilter}
          onSelectAll={selectAllFilters}
          onClear={clearFilters}
          onTimeChange={setTimeId}
          onModeChange={setModeId}
          disabled={loading}
        />
      </div>

      {/* 概况：把「多少分钟能到多远」这件事说清楚 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-zinc-600">
        <span>
          {previewing ? (
            <>
              {previewKind === "poi" && (
                <>
                  只看收藏的
                  <b className="ml-0.5 text-zinc-900">「{preview.poi?.name ?? "—"}」</b>
                </>
              )}
              {previewKind === "waypoint" && (
                <>
                  只看路标
                  <b className="ml-0.5 text-zinc-900">「{preview.wp?.label || "路标"}」</b>
                </>
              )}
              {previewKind === "favorites" && (
                <>
                  只看全部收藏{" "}
                  <b className="text-zinc-900">{favoritePois.length}</b> 个点
                </>
              )}
              {previewKind === "waypoints" && (
                <>
                  只看全部路标{" "}
                  <b className="text-zinc-900">{waypoints.length}</b> 个点
                </>
              )}
              {previewKind === "checkin" && (
                <>
                  只看打卡的
                  <b className="ml-0.5 text-zinc-900">
                    「{preview.item?.label || preview.item?.name || "—"}」
                  </b>
                </>
              )}
              {previewKind === "checkins" && (
                <>
                  只看全部打卡{" "}
                  <b className="text-zinc-900">{checkins.length}</b> 个点
                </>
              )}
              <span className="ml-1 text-xs text-zinc-400">（其他节点已隐藏）</span>
              <button
                type="button"
                onClick={exitPreview}
                className="ml-2 rounded-md border border-sky-300 bg-sky-50/70 px-2 py-0.5 text-xs text-sky-800 transition-colors hover:bg-sky-100"
              >
                退出预览
              </button>
            </>
          ) : hidden ? (
            <>
              不显示模式：图上
              <b className="text-zinc-900">{selectedPoi ? 1 : 0}</b> 个节点
              <span className="ml-1 text-xs text-zinc-400">
                （点「我的收藏」里的地点可以定位到它）
              </span>
            </>
          ) : (
            <>
              当前范围 <b className="text-zinc-900">{visiblePois.length}</b> 个地点
              {/* 多选之后得说清楚"现在看了哪几类"，否则点掉一个类型也看不出少的是什么 */}
              <span className="ml-1 text-xs text-zinc-400">
                （已选 {selectedIds.length}/{FILTER_TYPE_IDS.length} 类
                {selectedIds.length < FILTER_TYPE_IDS.length &&
                  `：${FILTER_OPTIONS.filter((c) => selectedIds.includes(c.id))
                    .map((c) => c.label)
                    .join("、")}`}
                ）
              </span>
              {/* 淡出不是删除，必须说清楚，否则 12427 个点只亮着两百来个会被当成丢数据 */}
              {visibleCount > 0 && visibleCount < visiblePois.length && (
                <span className="ml-1 text-xs text-zinc-400">
                  （同屏太密的已淡出 {visiblePois.length - visibleCount} 个，放大就恢复）
                </span>
              )}
            </>
          )}
        </span>
        <span className="text-zinc-400">
          {modeById(modeId).label} {timeById(timeId).label} ≈ {formatDistance(reach)}
          {clipped && `（数据只覆盖 ${formatDistance(radius)}）`}
        </span>
        {noResult && <span className="text-amber-700">这段时间内没有此类地点</span>}
        {/* 浮层关着的时候错误也得看得见，否则点了收藏没反应还没提示 */}
        {favError && !favOpen && <span className="text-red-600">收藏出错：{favError}</span>}
        {checkinError && !checkinOpen && (
          <span className="text-red-600">打卡出错：{checkinError}</span>
        )}
      </div>

      {/* 图例：颜色和地图上的标记一一对应，顺便说明蓝色块的含义。
          交通已经按地铁/公交分色，所以这里列的是筛选条上的那 7 个配色。 */}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[14px] border border-zinc-200 bg-white/80 px-4 py-3 text-xs text-zinc-500">
        {FILTER_OPTIONS.filter((c) => c.id !== "all").map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: c.color }}
              aria-hidden="true"
            />
            {c.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: "rgba(29, 111, 214, 0.35)" }}
            aria-hidden="true"
          />
          景点占地
        </span>
        <span className="text-zinc-400">点击地图上的标记可查看详情</span>
        {/* ODbL 要求署名，这条不是装饰：只要数据来自 OSM 就必须显示 */}
        {dataOrigin === "openstreetmap" && (
          <span className="text-zinc-400">
            地点数据 ©{" "}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-zinc-300 underline-offset-2 transition-colors hover:text-zinc-600"
            >
              OpenStreetMap
            </a>{" "}
            贡献者（ODbL）
          </span>
        )}
      </div>

      {!process.env.NEXT_PUBLIC_TMAP_KEY && !process.env.NEXT_PUBLIC_TMAP_PROXY_HOST && (
        <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
          浏览器端还没配 <code className="font-mono">NEXT_PUBLIC_TMAP_KEY</code>
          ，底图会是空白的。这个是给浏览器加载地图 SDK 用的公开 key，和服务端
          <code className="mx-1 font-mono">TENCENT_MAP_KEY</code> 不是同一个用途。
        </p>
      )}

      {/* 「特定节点展示」的淡蓝色边框。
          进：从窗口里被点的那一行长成一块小框，飞到地图上贴住四边（四个属性一起过渡），
              贴合完成后框内顶部中央出现「特定节点展示 ×」。
          出：整块 opacity → 0 淡掉，同时数据恢复、地图 easeTo 回初始视野。
          fixed 定位是必须的：它要跨越「窗口」和「地图」两个容器。
          pointer-events 只在那个小标签上打开，否则边框会挡住地图点击。 */}
      {frame && (
        <div
          // z-index 压在两个窗口（z-2000 / 2100）**下面**：
          // 窗口是浮在地图里的，框要是盖在它们上面，边框会横穿窗口、
          // 还会正好切掉窗口的圆角（用户反馈「边框把窗口遮住了」）。
          //
          // 6px 深蓝边框 + 内侧 2px 更深的描线（inset shadow）：
          // 外圈负责"看得见"，内圈负责"边界扎得住"，只有外圈时边界仍是虚的。
          className="pointer-events-none fixed z-[1900] rounded-[18px] border-[6px] border-sky-600/80"
          style={{
            left: frame.style.left,
            top: frame.style.top,
            width: frame.style.width,
            height: frame.style.height,
            opacity: frame.visible ? 1 : 0,
            boxShadow: `inset 0 0 0 2px rgba(7, 89, 133, 0.92)${
              frame.label ? ", 0 0 0 4px rgba(56,189,248,0.26)" : ""
            }`,
            transition: frame.animate
              ? "left 460ms cubic-bezier(.4,0,.2,1), top 460ms cubic-bezier(.4,0,.2,1), width 460ms cubic-bezier(.4,0,.2,1), height 460ms cubic-bezier(.4,0,.2,1), opacity 380ms ease, box-shadow 300ms ease"
              : "opacity 200ms ease",
          }}
        >
          {/* 框内的蓝雾（2026-10-29 新增，用户要"把框内整体压暗一点点，像聚焦"）。
              两层结构是必须的：外层负责裁剪，内层负责"散开"时往外飘出去 ——
              内层 scale 到 1.18 时会被外层 overflow-hidden 切住，视觉上就是
              "雾被推出画面四边"，而不是整块放大盖到地图外面去。

              用 radial-gradient 而不是纯色：中心几乎透明、贴边略深，
              中间那些标记不受影响，四角自然暗下去 —— 这才是镜头聚焦的感觉。
              纯 rgba(56,189,248,.05) 铺满会把整张图均匀蒙一层，看着像屏幕脏了。 */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden"
            style={{ borderRadius: 12 }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 12,
                background:
                  "radial-gradient(115% 115% at 50% 46%, rgba(125,211,252,0.035) 32%, rgba(2,132,199,0.13) 100%)",
                // 进场：标签出现的同一刻淡入；退场：fogOut 一置位就开始往外散
                opacity: frame.fogOut ? 0 : frame.label ? 1 : 0,
                transform: frame.fogOut ? "scale(1.18)" : "scale(1)",
                filter: frame.fogOut ? "blur(10px)" : "blur(0px)",
                transition: frame.fogOut
                  ? "opacity 560ms ease-out, transform 620ms cubic-bezier(.22,.61,.36,1), filter 620ms ease-out"
                  : "opacity 420ms ease-out",
              }}
            />
          </div>

          {frame.label && (
            <div className="pointer-events-auto absolute inset-x-0 top-2 flex justify-center">
              {/* 标签也要"看得清"：白底 + 深色粗体大字 + 实心蓝底 ×，
                  原来是 12px 的浅蓝字浮在浅蓝底上，几乎糊进地图。 */}
              <span className="flex items-center gap-2.5 rounded-full bg-white py-1.5 pl-4 pr-2 text-[15px] font-semibold tracking-wide text-sky-900 shadow-md ring-2 ring-sky-600/70">
                特定节点展示
                <button
                  type="button"
                  onClick={exitPreview}
                  aria-label="退出特定节点展示"
                  title="退出预览并恢复地图"
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-600 text-[16px] leading-none text-white transition-colors hover:bg-sky-700"
                >
                  ×
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
