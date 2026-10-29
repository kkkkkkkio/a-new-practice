"use client";

// 只负责「画图 + 点开一个点」：接收 props → 初始化一次地图 → props 变了就调 setGeometries 更新图层。
// 不取数据、不存筛选状态，那些都在 MapView 里。

import { useCallback, useEffect, useRef, useState } from "react";
import { CATEGORIES, TRANSIT_KINDS, categoryLabel, poiColor, transitKindLabel } from "@/lib/categories";
import { formatDistance, formatDuration, travelMinutes } from "@/lib/travel";

// SDK 地址：有 key 时追加 &key=xxx；没有 key 时原样请求（走代理模式）。
const SDK_SRC = "https://map.qq.com/api/gljs?v=1.exp";

// 两个可选的环境变量（写在项目根目录 .env.local，改完要重启 dev server）：
//   NEXT_PUBLIC_TMAP_KEY        腾讯位置服务申请的 key —— 推荐用法
//   NEXT_PUBLIC_TMAP_PROXY_HOST 代理免 key 模式的转发地址
const API_KEY = process.env.NEXT_PUBLIC_TMAP_KEY;
const PROXY_HOST = process.env.NEXT_PUBLIC_TMAP_PROXY_HOST;

// 点击标记后缩放到几级。zoom 19 时比例尺才是「10 米」这一档
// （zoom 18 是「20 米」，实测差一级，需求要的是 50 英尺/10 米）。
const FOCUS_ZOOM = 19;
// 缩放动画时长。需求文档原本写的是 0.2 秒（"0.2 秒内变为 50 英尺/10 米"），
// 但那个速度看起来像瞬移，用户后来要求放慢到 1 秒。
const FOCUS_DURATION_MS = 1000;

// 从「我的收藏」定位时用的缩放级别（第二轮需求 1：比例尺 400 英尺 : 100 米）。
//
// 这个数字是实测出来的，不是拍的：腾讯比例尺控件按 1-2-5 分级，
// 在 (39.98, 116.35) 这一带实测 zoom 14 → 「500 米」、15 → 「200 米」、16 → 「100 米」、
// 17 → 「50 米」、18 → 「20 米」、19 → 「10 米」。400 英尺 = 121.9 米，
// 最接近的就是 zoom 16 那一档（比例尺两端标 100 米照 400 英尺，公制/英制本来就是取整显示）。
// 换成纯公式算也对得上：mpp = 156543*cos(lat)/2^zoom，zoom 16 → 1.83 米/像素。
const FAVORITE_ZOOM = 16;
const FAVORITE_DURATION_MS = 900;

// 密集地标淡出的判定（第二轮需求 2，已确认口径）：
//   屏幕上 40 像素半径的圆内同时出现 5 个以上地标 → 该范围随机留 1 个正常显示，其余淡去。
// 原稿写的是「1 厘米」，按 96dpi 折算成 40px；用像素而不是厘米，是为了不同设备上可复现。
const DENSE_RADIUS_PX = 40;
const DENSE_MIN = 5;
// 淡出到什么程度。0.28 既能看出"这里还有东西"，又不会和正常点抢注意力。
const FADED_OPACITY = 0.28;

// 模块级单例：React 19 开发模式 StrictMode 会把 effect 跑两遍，
// 不做幂等就会插两个 <script>，第二个覆盖第一个，地图直接白掉。
let sdkPromise = null;

function loadTMapSdk() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.TMap) return Promise.resolve();
  if (sdkPromise) return sdkPromise;

  // 代理免 key 模式：必须在插 script 之前设好
  if (PROXY_HOST && !window._TMapSecurityConfig) {
    window._TMapSecurityConfig = { serviceHost: PROXY_HOST };
  }

  const src = API_KEY ? `${SDK_SRC}&key=${encodeURIComponent(API_KEY)}` : SDK_SRC;

  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      if (window.TMap) resolve();
      else reject(new Error("SDK 下载成功，但没有挂上 window.TMap"));
    };
    script.onerror = () => reject(new Error(`腾讯地图 SDK 下载失败：${src}`));
    document.head.appendChild(script);
  });

  return sdkPromise;
}

// 图标是内联 SVG 转 data URI，按颜色缓存，避免反复拼字符串
const pinCache = new Map();

// 打卡过的地方：**边框从白变黄 + 内部打 4 根等距黄色反斜线**（2026-10-29 第二次改版）。
//
// 为什么不是整根图钉换色：颜色本身在这个地图上是有含义的
// （橙餐饮 / 紫商场 / 深蓝地铁……），整根换掉就把分类信息抹了。
// 换成"黄描边 + 黄色斜纹"，等于给这个点盖了个章 —— 一眼扫得出"这片我打过卡"，
// 原来的分类配色还留着。
//
// 斜线必须**裁剪在图钉轮廓里**（clipPath），否则会画到图钉外面的透明区域上，
// 6 张不同的图标叠在地图上时会变成一堆互相穿插的黄条。
const CHECKED_YELLOW = "#ffd400";

/**
 * 生成一组等距反斜线（"\" 方向，即 y = x + k），坐标故意超出视口，
 * 靠外层 clipPath 裁掉 —— 这样每条线的长度都不用单独算。
 *
 * @param ks 每条线的 k 值。相邻 k 相差 d 时，垂直间距是 d/√2
 * @param h  视口的最大高度（线从 y=0 拉到 y=h）
 */
function stripes(ks, h) {
  return ks.map((k) => `<line x1="${-k}" y1="0" x2="${h - k}" y2="${h}"/>`).join("");
}

function pinSrc(color, checked = false) {
  const cacheKey = checked ? `${color}|checked` : color;
  if (pinCache.has(cacheKey)) return pinCache.get(cacheKey);

  const body = "M13 1C6.3 1 1 6.3 1 13c0 8.8 12 20 12 20s12-11.2 12-20C25 6.3 19.7 1 13 1Z";
  // 反斜线的 k：-12 / -4 / 4 / 12，相邻差 8 → 垂直间距 8/√2 ≈ 5.7px，
  // 线宽 2.8 大约占一半，在 26px 宽的图钉上既够粗又数得清是 4 根。
  // k 取成关于 0 对称（±4 / ±12），斜纹才在钉头圆心上居中，不会一边挤一边空。
  //
  // 裁剪路径要**往里缩一点**（scale 0.86）：不缩的话斜纹会正好顶到描边上，
  // 黄描边和黄斜纹连成一片，就看不出"有边框"这件事了。缩一圈留出一条底色缝，
  // 才能同时看见「黄边框 + 底色 + 黄斜纹」三层。
  const svg = checked
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">
  <defs><clipPath id="pinClip"><path d="${body}" transform="translate(13 13) scale(0.86) translate(-13 -13)"/></clipPath></defs>
  <path d="${body}" fill="${color}" stroke="${CHECKED_YELLOW}" stroke-width="2"/>
  <g clip-path="url(#pinClip)" stroke="${CHECKED_YELLOW}" stroke-width="2.6">
    ${stripes([-12, -4, 4, 12], 34)}
  </g>
</svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">
  <path d="${body}" fill="${color}" stroke="#ffffff" stroke-width="2"/>
  <circle cx="13" cy="13" r="4.5" fill="#ffffff"/>
</svg>`;
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  pinCache.set(cacheKey, src);
  return src;
}

// 远视角用的小圆点。15km 视野下 1200 个 26×34 的 pin 会互相叠成一片色块，
// 真实地图在这个级别都是画点不画 pin —— 同样数量的点，点能看出疏密，pin 只能看出糊。
const dotCache = new Map();
const DOT_ZOOM_MAX = 12; // 缩放级别 <= 12 时改用圆点

function dotSrc(color, checked = false) {
  const cacheKey = checked ? `${color}|checked` : color;
  if (dotCache.has(cacheKey)) return dotCache.get(cacheKey);
  // 缩到圆点级别（zoom ≤ 12）后，4 根斜线在 12px 里根本分辨不出来，
  // 所以这里只保留「边框变黄」这一个特征 —— 远看是一圈黄边的小点，近看才是斜纹。
  const svg = checked
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
  <circle cx="6" cy="6" r="4.2" fill="${color}" stroke="${CHECKED_YELLOW}" stroke-width="1.8"/>
</svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
  <circle cx="6" cy="6" r="4.5" fill="${color}" stroke="#ffffff" stroke-width="1.2"/>
</svg>`;
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  dotCache.set(cacheKey, src);
  return src;
}

// 每个分类两种样式：pin（近看）和圆点（远看）。geometry 的 styleId 按缩放级别二选一。
// 交通按子类分色（地铁深蓝 / 公交浅蓝），所以样式键不是 category 而是一个「配色键」：
//   restaurant / cafe / attraction / mall / market / subway / bus
const STYLE_KEYS = [
  ...CATEGORIES.filter((c) => c.id !== "transit").map((c) => ({ key: c.id, color: c.color })),
  ...TRANSIT_KINDS.map((k) => ({ key: k.id, color: k.color })),
];

// 同一个点，配色键怎么取
function styleKeyOf(poi) {
  if (poi.category === "transit") return poi.kind === "subway" ? "subway" : "bus";
  return poi.category;
}

// 高亮用的小光圈：比圆点大一圈、中间留白，一眼能从一堆点里挑出来
const haloCache = new Map();
function haloSrc(color) {
  if (haloCache.has(color)) return haloCache.get(color);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
  <circle cx="11" cy="11" r="9.5" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2"/>
  <circle cx="11" cy="11" r="4.5" fill="${color}"/>
</svg>`;
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  haloCache.set(color, src);
  return src;
}

// 路标（2026-10-29 改版）：原来是面小橙旗，用户说「不太明显」。
//
// 现在直接用 POI 那个 pin 的形状，只是：
//   - 颜色换成红色 #e03131（暖色里最扎眼的一个）；
//   - 尺寸放大到 36×45（普通 pin 是 26×34，大约 1.4 倍）；
//   - **加一圈深色描边 #7f1d1d**：红和餐饮的橙 #e8590c 在密集区还是容易混，
//     深色外圈把边界钉死了，远看也是一块独立的红。
//
// 描边怎么画出来的：同一条 path 画两遍 ——
//   第一遍带 stroke（4.5 宽，居中在路径上，等于外扩 2.25），
//   第二遍只填色不带 stroke，正好盖掉内侧那半圈，最后只剩外圈。
// 这样做是为了拿到"只在外面"的描边（SVG 的 stroke 默认是骑在路径上的，
// 直接用会同时吃掉内侧一半，颜色显得脏）。
// 坐标整体平移到 32×40 的 viewBox 里，就是为了给外扩的那 2.25 留出空间不被裁掉。
//
// 另外这条样式**只有一份**，没有任何 `:faded` / `:dot` 变体 —— 缩小地图时
// paintMarkers() 只重设普通 POI 图层的 styleId，路标图层根本不参与密度判定，
// 所以它永远是最清楚的红色大 pin，不会被虚化、也不会缩成小圆点。
const WAYPOINT_SIZE = { width: 36, height: 45 };
const WAYPOINT_OUTLINE = "#7f1d1d";
// 打卡过的路标：和普通 POI 一个规则 —— 描边从深红换成黄、内部打 4 根黄斜纹。
// 深红描边（WAYPOINT_OUTLINE）本来是给"没打卡"的红图钉钉边界的，打卡后换成黄色，
// 红底 + 黄纹和普通红图钉一眼就能分开。
// 斜纹的间距按这枚图钉放大后的尺寸算：k 相差 10 → 垂直 7.07px，线宽 3.6 还剩 3.5px 缝。
function waypointSrc(checked = false) {
  const pin = "M16 4C9.3 4 4 9.3 4 16c0 8.8 12 20 12 20s12-11.2 12-20C28 9.3 22.7 4 16 4Z";
  const svg = checked
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="45" viewBox="0 0 32 40">
  <defs><clipPath id="wpClip"><path d="${pin}" transform="translate(16 16) scale(0.87) translate(-16 -16)"/></clipPath></defs>
  <path d="${pin}" fill="#e03131" stroke="${CHECKED_YELLOW}" stroke-width="4.5" stroke-linejoin="round"/>
  <path d="${pin}" fill="#e03131"/>
  <g clip-path="url(#wpClip)" stroke="${CHECKED_YELLOW}" stroke-width="3.2">
    ${stripes([-15, -5, 5, 15], 40)}
  </g>
</svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="45" viewBox="0 0 32 40">
  <path d="${pin}" fill="#e03131" stroke="${WAYPOINT_OUTLINE}" stroke-width="4.5" stroke-linejoin="round"/>
  <path d="${pin}" fill="#e03131"/>
  <circle cx="16" cy="16" r="4.5" fill="#ffffff" stroke="${WAYPOINT_OUTLINE}" stroke-width="1.4"/>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
const WAYPOINT_SRC = waypointSrc(false);
const WAYPOINT_SRC_CHECKED = waypointSrc(true);

// 普通 POI 弹窗往上抬多少：pin 是 26×34，抬 40 正好落在它头顶上
const POI_POPUP_OFFSET = { x: 0, y: -40 };

// 每个配色键 5 种样式：
//   近看 pin / 远看圆点 / 淡出 pin / 淡出圆点 / 高亮光圈
// 淡出用 MarkerStyle 的 opacity 实现（SDK 支持逐样式设透明度），
// 这样被淡掉的点还在图层里，放大后判定不成立就立刻恢复成正常样式，不需要重新加回来。
function buildMarkerStyles(TMap) {
  const styles = {};
  for (const { key, color } of STYLE_KEYS) {
    const pin = () =>
      new TMap.MarkerStyle({ width: 26, height: 34, anchor: { x: 13, y: 34 }, src: pinSrc(color) });
    const dot = () =>
      new TMap.MarkerStyle({ width: 12, height: 12, anchor: { x: 6, y: 6 }, src: dotSrc(color) });

    styles[key] = pin();
    styles[`${key}:dot`] = dot();
    // 打卡过的两种（近看 pin / 远看圆点）。刻意**不给**它们做 faded 变体：
    // 打卡是用户自己标记的"我来过"，在密集区被淡掉就失去意义了，
    // 所以 paintMarkers 里 checked 的优先级高于 faded，直接跳过淡出。
    styles[`${key}:checked`] = new TMap.MarkerStyle({
      width: 26,
      height: 34,
      anchor: { x: 13, y: 34 },
      src: pinSrc(color, true),
    });
    styles[`${key}:dotChecked`] = new TMap.MarkerStyle({
      width: 12,
      height: 12,
      anchor: { x: 6, y: 6 },
      src: dotSrc(color, true),
    });
    styles[`${key}:faded`] = new TMap.MarkerStyle({
      width: 26,
      height: 34,
      anchor: { x: 13, y: 34 },
      src: pinSrc(color),
      opacity: FADED_OPACITY,
    });
    styles[`${key}:dotFaded`] = new TMap.MarkerStyle({
      width: 12,
      height: 12,
      anchor: { x: 6, y: 6 },
      src: dotSrc(color),
      opacity: FADED_OPACITY,
    });
    styles[`${key}:hl`] = new TMap.MarkerStyle({
      width: 22,
      height: 22,
      anchor: { x: 11, y: 11 },
      src: haloSrc(color),
    });
  }
  // 路标单独一套：**只有这一种样式**，没有 :faded / :dot / :hl 变体。
  // anchor 落在针尖（36 宽取 18、47 高取 47），这样尖端指的才是真实坐标。
  styles.waypoint = new TMap.MarkerStyle({
    width: WAYPOINT_SIZE.width,
    height: WAYPOINT_SIZE.height,
    anchor: { x: WAYPOINT_SIZE.width / 2, y: WAYPOINT_SIZE.height },
    src: WAYPOINT_SRC,
  });
  // 打过卡的路标：同样只有这一种变体（没有 faded/dot），只换中心那个洞的颜色
  styles.waypointChecked = new TMap.MarkerStyle({
    width: WAYPOINT_SIZE.width,
    height: WAYPOINT_SIZE.height,
    anchor: { x: WAYPOINT_SIZE.width / 2, y: WAYPOINT_SIZE.height },
    src: WAYPOINT_SRC_CHECKED,
  });
  return styles;
}

// 两种圆，含义必须分清（以前只有一个，画的是"被上限截断后的请求半径"，
// 所以骑行一小时也显示 2.2km，属于假信息）：
//   reach    紫色虚线 = 「这段时间 / 这种出行方式真的能到多远」
//   coverage 灰色点线 = 「这一份数据实际覆盖到哪」（只在可达圈更大时才画）
function buildCircleStyles(TMap) {
  return {
    reach: new TMap.CircleStyle({
      color: "rgba(114, 111, 171, 0.10)",
      showBorder: true,
      borderColor: "#726fab",
      borderWidth: 2,
      borderDashArray: [8, 6],
    }),
    coverage: new TMap.CircleStyle({
      // 填充设为全透明：两个圈套着的时候，叠加的色块会让人以为数据被分成两层
      color: "rgba(0, 0, 0, 0)",
      showBorder: true,
      borderColor: "rgba(113, 113, 122, 0.65)",
      borderWidth: 1,
      borderDashArray: [3, 5],
    }),
  };
}

// 把「半径 r 米」换算成能整个装进视野的缩放级别。
// 腾讯 GL JS 没有可靠的 fitBounds，直接按墨卡托公式算：
//   某一级别下每像素多少米 = 156543.03392 * cos(lat) / 2^zoom
// 要求 2r <= 视野短边 * 0.85 * mpp，解出 zoom。
function fitZoom(radiusM, lat, width, height) {
  const minDim = Math.max(1, Math.min(width || 800, height || 520));
  const mppAtZoom0 = 156543.03392 * Math.cos((lat * Math.PI) / 180);
  const z = Math.log2((mppAtZoom0 * minDim * 0.85) / (2 * Math.max(1, radiusM)));
  return Math.max(4, Math.min(16, Math.round(z)));
}

/**
 * 稳定伪随机：同一个 id 永远得到同一个 [0,1) 数。
 *
 * 需求 2 说「随机保留 1 个」。这里**不用 Math.random()**：那个每次调用结果都变，
 * 缩放一下亮着的点就换成另一个，看起来像在闪。用 id 的哈希当随机数，效果是随机的
 * （点之间没有规律），但对同一个点、同一份数据是稳定的 —— 缩放来回拉也不会乱跳。
 */
function stableRandom(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * 密集判定（需求 2）：屏幕上 40px 半径内 ≥5 个地标 → 随机留 1 个，其余标记为淡出。
 *
 * 算法是「空间哈希 + 贪心分组」，不是对每个点做 O(n²) 全扫：
 * 先按 40px 分桶，一个点只跟自己的 3×3 邻桶比，复杂度 O(n·k)（k 是邻桶里的点数，
 * 15km 视野下量级几十）。分组一旦定下来就打上 decided 标记，避免同一个点被两组
 * 重复处理导致一次淡出两次。
 *
 * @param {{id:string,x:number,y:number}[]} points 屏幕坐标
 * @param {Set<string>} keep 无论如何都要显示的点（比如同线路高亮的那些）
 * @returns {Set<string>} 该淡出的 id
 */
function computeFaded(points, keep) {
  const cell = DENSE_RADIUS_PX;
  const grid = new Map();
  for (const p of points) {
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(p);
    else grid.set(key, [p]);
  }

  const decided = new Set();
  const faded = new Set();
  const r2 = DENSE_RADIUS_PX * DENSE_RADIUS_PX;

  for (const p of points) {
    if (decided.has(p.id)) continue;

    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    const group = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const q of bucket) {
          if (decided.has(q.id)) continue;
          const ddx = q.x - p.x;
          const ddy = q.y - p.y;
          if (ddx * ddx + ddy * ddy <= r2) group.push(q);
        }
      }
    }

    // 「5 个以上」= 包含自己在内 ≥5 个
    if (group.length < DENSE_MIN) {
      for (const q of group) decided.add(q.id);
      continue;
    }

    let winner = group[0];
    let best = stableRandom(winner.id);
    for (const q of group) {
      const r = stableRandom(q.id);
      if (r < best) {
        best = r;
        winner = q;
      }
    }
    // 高亮的点必须留着：否则整条线路在某些缩放级别会缺一段，看起来像数据不全
    if (keep?.has(winner.id)) {
      for (const q of group) decided.add(q.id);
      continue;
    }

    for (const q of group) {
      decided.add(q.id);
      if (q !== winner) faded.add(q.id);
    }
  }
  return faded;
}

// 景点占地：OSM 的真实轮廓（way/relation 的坐标点），蓝色半透明填充
function buildPolygonStyles(TMap) {
  return {
    attractionArea: new TMap.PolygonStyle({
      // 多个景点挨在一起时面会重叠，透明度取 0.14，叠两三层也不会糊成一片
      color: "rgba(29, 111, 214, 0.18)",
      showBorder: true,
      borderColor: "rgba(29, 111, 214, 0.5)",
      borderWidth: 1,
    }),
  };
}

// 上游的名称/地址是外部数据，拼进 HTML 前必须转义，否则一个 & 就能把弹窗搞坏
function esc(text) {
  return String(text ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

const POPUP_FONT =
  'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';

/**
 * 屏幕像素 → 经纬度。拖动路标要用。
 *
 * 优先用 SDK 的 unprojectFromContainer（它考虑旋转和倾斜）；万一那个方法对入参
 * 形态挑剔、或者地图还没铺好，就退回墨卡托自己反算 —— 后者不考虑旋转/倾斜，
 * 但在地图没转过的时候完全够用，比"拖不动"强。
 */
function pixelToLatLng(map, el, x, y) {
  if (!map) return null;

  try {
    const ll = map.unprojectFromContainer?.({ x, y });
    if (ll) {
      const lat = typeof ll.getLat === "function" ? ll.getLat() : ll.lat;
      const lng = typeof ll.getLng === "function" ? ll.getLng() : ll.lng;
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  } catch {
    // 落到下面的兜底算法
  }

  const c = map.getCenter?.();
  const z = map.getZoom?.();
  if (!c || !Number.isFinite(z) || !el) return null;

  const lat = typeof c.getLat === "function" ? c.getLat() : c.lat;
  const lng = typeof c.getLng === "function" ? c.getLng() : c.lng;
  const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
  const dLng = ((x - el.clientWidth / 2) * mpp) / (111320 * Math.cos((lat * Math.PI) / 180));
  const dLat = -((y - el.clientHeight / 2) * mpp) / 110540;
  return { lat: lat + dLat, lng: lng + dLng };
}

// 路标的「删除交互」气泡（需求 6：再次点击某个路标 → 进入删除交互）
// 2026-10-29 加了「打卡」：自己放的路标也能打卡，规则和 POI 一样（中心那个洞变黄）。
function waypointDeleteHtml(wp, { checked = false } = {}) {
  return `
<div style="${POPUP_FONT}min-width:150px;padding:1px;">
  <div style="font-size:13.5px;font-weight:600;color:#18181b;line-height:1.4;">${esc(wp.label || `路标 ${wp.id}`)}</div>
  <div style="font-size:11.5px;color:#a1a1aa;margin-top:3px;line-height:1.6;">要删掉这个路标吗？</div>
  <div style="display:flex;gap:6px;margin-top:8px;">
  <button type="button" data-check-wp="${esc(String(wp.id))}"
    style="${POPUP_FONT}display:inline-block;padding:4px 11px;border-radius:8px;
      border:1px solid ${checked ? "#e0b400" : "#d4d4d8"};
      background:${checked ? "#fff8dc" : "#ffffff"};
      color:${checked ? "#8a6d1f" : "#52525b"};font-size:12.5px;line-height:1.4;cursor:pointer;">
    ${checked ? "✓ 已打卡" : "○ 打卡"}
  </button>
  <button type="button" data-wp-del="${esc(String(wp.id))}"
    style="${POPUP_FONT}display:inline-block;padding:4px 11px;border-radius:8px;
      border:1px solid #f0b4b4;background:#fef2f2;color:#b91c1c;font-size:12.5px;line-height:1.4;cursor:pointer;">
    删除路标
  </button>
  </div>
</div>`;
}

/**
 * 弹窗内容。**只放真实数据**：名称 / 分类 / 距离 / 出行时间 / 地址。
 *
 * 早期版本这里还有「营业时间」「人均消费」「占地范围」，那三项是按 id 哈希
 * 从固定候选池里挑出来的演示值，跟真实商户毫无关系，已经整体删除。
 * 要恢复这几行，得先有真实数据源（腾讯 POI 详情接口或自建商家库）。
 *
 * 注意用内联 style 而不是 Tailwind class：这段 HTML 是运行时拼出来的字符串，
 * Tailwind 编译时扫不到，写 class 不会生成对应样式。
 */
function buildPopupHtml(poi, modeId, { source = "", favorited = false, checked = false } = {}) {
  const color = poiColor(poi);
  // 交通点显示「地铁站 / 公交站」，其它分类照旧显示分类名（第二轮需求 3）
  const label =
    poi.category === "transit" ? `${transitKindLabel(poi.kind)}站` : categoryLabel(poi.category);
  const modeLabel = modeId === "bike" ? "骑行" : "步行";
  const minutes = travelMinutes(poi.distance, modeId);

  // 线路（第二轮需求 3：地铁给「几号线」，公交给「几路」）。
  // 数据来自 OSM 的 route 关系，不是编的；实在没有就不显示这一行。
  const MAX_LINES = 6;
  const lines = Array.isArray(poi.lines) ? poi.lines : [];
  const linesLine = lines.length
    ? `
  <div style="${POPUP_FONT}font-size:12px;color:#3f3f46;line-height:1.65;margin-top:5px;"
       title="${esc(lines.join("、"))}">
    <span style="color:#a1a1aa;">${poi.category === "transit" ? "途经" : "线路"}：</span>${lines
      .slice(0, MAX_LINES)
      .map(esc)
      .join("、")}${lines.length > MAX_LINES ? ` 等 ${lines.length} 条` : ""}
  </div>`
    : "";

  // 收藏按钮：这段 HTML 不在 React 树里，所以只能靠 data-* 属性带上「是谁」，
  // 由外层用 document 事件委托统一接住（TMap.InfoWindow 不认 React 的事件）。
  // source 必须一起带出去：mock 和真实数据的 id 是两套，少了它就会收错东西。
  const favButton = `
    <button type="button"
      data-fav-poi="${esc(poi.id)}"
      data-fav-source="${esc(source)}"
      style="${POPUP_FONT}display:inline-block;padding:4px 11px;border-radius:8px;
        border:1px solid ${favorited ? "#b8a94a" : "#d4d4d8"};
        background:${favorited ? "#fdf6d8" : "#ffffff"};
        color:${favorited ? "#8a6d1f" : "#52525b"};
        font-size:12.5px;line-height:1.4;cursor:pointer;">
      ${favorited ? "★ 已收藏" : "☆ 收藏"}
    </button>`;

  // 打卡按钮（2026-10-29）。同样靠 data-* 把「是谁」带出去，由 document 上的委托接住。
  // 勾上以后图钉中间的洞会变黄，所以这里的文案也用同一个符号语言（○ → ✓）。
  const checkButton = `
    <button type="button"
      data-check-poi="${esc(poi.id)}"
      data-check-source="${esc(source)}"
      style="${POPUP_FONT}display:inline-block;padding:4px 11px;border-radius:8px;
        border:1px solid ${checked ? "#e0b400" : "#d4d4d8"};
        background:${checked ? "#fff8dc" : "#ffffff"};
        color:${checked ? "#8a6d1f" : "#52525b"};
        font-size:12.5px;line-height:1.4;cursor:pointer;">
      ${checked ? "✓ 已打卡" : "○ 打卡"}
    </button>`;

  // 景区里的小景点在数据整理阶段已经并进父景区（不再单独占标记），
  // 但它们是真实存在的，得让人知道园子里还有这些 —— 折进来不等于删掉。
  // 只列前 6 个，剩下的用总数带过；完整列表塞进 title，鼠标悬停能看到。
  const MAX_CONTAINED = 6;
  const contained = Array.isArray(poi.contains) ? poi.contains : [];
  const containsLine = contained.length
    ? `
  <div style="${POPUP_FONT}font-size:11.5px;color:#71717a;line-height:1.65;margin-top:7px;"
       title="${esc(contained.join("、"))}">
    <span style="color:#a1a1aa;">内含 ${contained.length} 处：</span>${contained
      .slice(0, MAX_CONTAINED)
      .map(esc)
      .join("、")}${contained.length > MAX_CONTAINED ? " …" : ""}
  </div>`
    : "";

  return `
<div style="${POPUP_FONT}min-width:170px;max-width:250px;padding:1px 1px 0;">
  <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
    <span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${color};flex:none;"></span>
    <span style="font-size:14.5px;font-weight:600;color:#18181b;line-height:1.35;">${esc(poi.name)}</span>
  </div>
  <div style="${POPUP_FONT}font-size:12px;color:#71717a;line-height:1.6;">
    ${esc(label)} · 距离 ${formatDistance(poi.distance)} · ${modeLabel}约 ${formatDuration(minutes)}
  </div>
  ${linesLine}
  <div style="height:1px;background:#e4e4e7;margin:8px 0;"></div>
  <div style="${POPUP_FONT}font-size:11.5px;color:#a1a1aa;line-height:1.6;">${esc(poi.address || "暂无详细地址")}</div>
  ${containsLine}
  <div style="display:flex;gap:6px;margin-top:9px;">${favButton}${checkButton}</div>
</div>`;
}

export default function MapCanvas({
  center,
  radius,
  // 这段时间 / 这种方式真的能到多远（没传就退化成 radius，保持老调用方可用）
  reach = 0,
  // 完整的点集：用来画标记、查弹窗、画景点轮廓
  pois,
  modeId = "walk",
  onSelect,
  dataSource = "",
  favoriteKeys,
  onToggleFavorite,
  // 打卡集合：key 和收藏一样是 `${source}:${poi_id}`，路标用 `waypoint:wp:<id>`。
  // 只用来决定「图钉中间那个洞是不是黄的」和弹窗里那颗按钮的文案。
  checkinKeys,
  onToggleCheckin,
  focusPoi,
  // 退出「特定节点展示」时上层把这个数 +1，地图 easeTo 回初始视野（等价于刚进页面那次）
  resetKey = 0,
  // 需求 5「不显示」：除 selectedPoi 以外什么都不画
  hidden = false,
  selectedPoi = null,
  // 需求 6/7 路标
  waypoints = [],
  waypointMode = false,
  onAddWaypoint,
  onMoveWaypoint,
  onDeleteWaypoint,
  // 点自己放的路标 → 上层要做一次「聚焦」：地图缩放 + 从 pin 上长出一个框飞向地图四边。
  // 传的是 (wp, rect)：rect 是 pin 此刻在屏幕上的矩形，边框动画就从那儿起飞。
  onFocusWaypoint,
  // 当前是不是处在「特定节点展示」里。点 pin 会顺手弹「要删除这个路标吗？」，
  // 用户点 × 退出后那个气泡得关掉 —— 不然图上留着一条没人管的确认框。
  previewing = false,
  // 把「同屏实际亮着几个」报给上层，概况行要用（需求 2 的淡出不能让人以为丢点了）
  onVisibleCount,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const waypointLayerRef = useRef(null);
  const circlesRef = useRef(null);
  // 景点占地用面（MultiPolygon）画，不是圆：坐标来自 OSM 的真实轮廓
  const polygonsRef = useRef(null);
  const infoWindowRef = useRef(null);

  // 点击回调只绑一次，所以它读的数据必须走 ref，不能靠闭包捕获首帧的值
  const poisRef = useRef(pois);
  const modeRef = useRef(modeId);

  // 收藏相关：同样是「只绑一次的回调要读最新值」。
  // 这些 ref 在渲染期间不读，所以统一放 effect 里同步 —— 渲染时写 ref 会被
  // react-hooks/refs 拦下（React 19 明确不建议）。
  // 安全性：读这些 ref 的都是事件回调或 await 之后的异步代码，一定晚于 effect；
  // 而 effect 按声明顺序执行，这两个同步 effect 排在下面的初始化 effect 之前。
  const dataSourceRef = useRef(dataSource);
  const favoriteKeysRef = useRef(favoriteKeys);
  const onToggleFavoriteRef = useRef(onToggleFavorite);
  const checkinKeysRef = useRef(checkinKeys);
  const onToggleCheckinRef = useRef(onToggleCheckin);
  // 路标相关回调 / 数据同理：拖动和点击的回调只绑一次，必须读最新值
  const waypointsRef = useRef(waypoints);
  const waypointModeRef = useRef(waypointMode);
  const onAddWaypointRef = useRef(onAddWaypoint);
  const onMoveWaypointRef = useRef(onMoveWaypoint);
  const onDeleteWaypointRef = useRef(onDeleteWaypoint);
  const onFocusWaypointRef = useRef(onFocusWaypoint);
  const onVisibleCountRef = useRef(onVisibleCount);

  useEffect(() => {
    poisRef.current = pois;
    modeRef.current = modeId;
    dataSourceRef.current = dataSource;
    favoriteKeysRef.current = favoriteKeys;
    onToggleFavoriteRef.current = onToggleFavorite;
    checkinKeysRef.current = checkinKeys;
    onToggleCheckinRef.current = onToggleCheckin;
    waypointsRef.current = waypoints;
    waypointModeRef.current = waypointMode;
    onAddWaypointRef.current = onAddWaypoint;
    onMoveWaypointRef.current = onMoveWaypoint;
    onDeleteWaypointRef.current = onDeleteWaypoint;
    onFocusWaypointRef.current = onFocusWaypoint;
    onVisibleCountRef.current = onVisibleCount;
  });

  // 当前弹窗对应哪个点。收藏状态一变就得重画弹窗内容（☆ ↔ ★），
  // 所以必须记住「现在开着的是谁」。null = 弹窗是关的。
  const openPoiRef = useRef(null);

  // 拼弹窗 HTML。只读 ref，所以首帧那个闭包也永远拿到最新值。
  const renderPopup = (poi) => {
    const source = dataSourceRef.current;
    return buildPopupHtml(poi, modeRef.current, {
      source,
      // 和 MapView 里维护的 Set 用同一套 key：source 参与，避免两套 id 互相认错
      favorited: Boolean(favoriteKeysRef.current?.has(`${source}:${poi.id}`)),
      checked: Boolean(checkinKeysRef.current?.has(`${source}:${poi.id}`)),
    });
  };

  // 初始化只跑一次，但 center 是异步取回来的；用 ref 取「最新值」，
  // 就不用把 center 写进初始化 effect 的依赖里（写了会导致重建地图）
  const centerRef = useRef(center);

  // 首帧的初值由 useRef(center) 带上了，这里只负责「后续 center 变了要跟上」。
  // 同样不能写在渲染期。
  useEffect(() => {
    centerRef.current = center;
  });

  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  // 远视角（缩放 <= 12）改用小圆点：pin 在那种级别只是互相遮挡
  const [compact, setCompact] = useState(false);

  // 需求 2：被判定为「太挤、要淡去」的标记 id。
  // 用 ref 而不是 state：它每次缩放都会重算，走 state 会把整个组件重渲染一遍，
  // 而我们真正要做的只是重设一次图层样式 —— 直接调 paintMarkers() 更省。
  const fadedRef = useRef(new Set());
  // 需求 4：同一线路高亮的 id
  const highlightRef = useRef(new Set());
  // 当前真正画在地图上的点（隐藏模式 / 单点模式下会被换掉）
  const drawnRef = useRef([]);
  const compactRef = useRef(false);
  // 拖动中的路标位置（还没落库，松手才提交）
  const [dragging, setDragging] = useState(null); // { id, lng, lat }
  // 拖动中的坐标也要给「命中判定 / 重绘」读，所以同一份数据再留一个 ref
  const draggingRef = useRef(null);
  const dragRef = useRef(null);
  // 正在等「删除确认」的路标 id（点一下路标弹出来）
  const waypointAskRef = useRef(null);
  // 刚处理完一次路标点击，接下来那一下地图 click 要忽略掉：
  // 两次事件是连着来的（mouseup 之后浏览器还会补一个 click），不忽略的话
  // 我们自己刚弹出的「删除这个路标？」会立刻被「点空白关弹窗」关掉。
  const suppressMapClickRef = useRef(false);
  // 上一次报告给上层的可见数，避免同一个数字反复 setState
  const lastVisibleRef = useRef(-1);

  // 预览结束的那一下，把「要删除这个路标吗？」的气泡收掉。
  // 触发条件是 previewing 由 true 变 false —— 而不是"路标列表变了"：
  // 退出预览时列表会从 [这一个] 变回 [全部]，但它仍然在里面，从数据上看不出差别。
  const previewingRef = useRef(previewing);
  useEffect(() => {
    if (previewingRef.current && !previewing && waypointAskRef.current !== null) {
      waypointAskRef.current = null;
      infoWindowRef.current?.setMap(null);
    }
    previewingRef.current = previewing;
  }, [previewing]);

  // 把「同屏真正亮着几个」报给上层。淡出不是删除，概况行必须说清楚这点，
  // 否则 12427 个点只亮着 200 个，看起来像数据丢了。
  const reportVisible = useCallback((n) => {
    if (lastVisibleRef.current === n) return;
    lastVisibleRef.current = n;
    onVisibleCountRef.current?.(n);
  }, []);

  // 按当前 faded / highlight 状态重设一次标记样式。
  // 只改 styleId，不动 geometry 的数量和位置 —— 这是「淡去」而不是「删掉」的物理实现：
  // 点一直在图层里，判定不成立时换个 styleId 就恢复了（需求 2 的「恢复」）。
  const paintMarkers = useCallback(() => {
    const TMap = typeof window === "undefined" ? null : window.TMap;
    const layer = markersRef.current;
    if (!TMap || !layer) return;

    const faded = fadedRef.current;
    const hl = highlightRef.current;
    const compactNow = compactRef.current;
    // 打卡集合按 `${source}:${poi_id}` 存（和收藏共用一套 key 规则），
    // 所以这里必须把当前数据源也拼进去，否则 mock 和真实数据会互相"冒充已打卡"。
    const checkedKeys = checkinKeysRef.current;
    const source = dataSourceRef.current;

    layer.setGeometries(
      drawnRef.current.map((p) => {
        const key = styleKeyOf(p);
        // 打卡优先于淡出：自己标记过的地方被密集判定淡掉，等于这个功能白做
        const isChecked = Boolean(checkedKeys?.has(`${source}:${p.id}`));
        let styleId;
        if (isChecked) styleId = compactNow ? `${key}:dotChecked` : `${key}:checked`;
        else if (hl.has(p.id)) styleId = `${key}:hl`;
        else if (faded.has(p.id)) styleId = compactNow ? `${key}:dotFaded` : `${key}:faded`;
        else styleId = compactNow ? `${key}:dot` : key;

        return {
          id: p.id,
          styleId,
          position: new TMap.LatLng(p.lat, p.lng),
          properties: { title: p.name, address: p.address },
        };
      }),
    );
  }, []);

  // 需求 2：重算「哪些点该淡出」。缩放结束 / 平移结束 / 数据变化时各算一次。
  const recomputeDensity = useCallback(() => {
    const map = mapRef.current;
    const TMap = typeof window === "undefined" ? null : window.TMap;
    const list = drawnRef.current;

    if (!map || !TMap || typeof map.projectToContainer !== "function" || list.length === 0) {
      if (fadedRef.current.size) {
        fadedRef.current = new Set();
        paintMarkers();
      }
      reportVisible(list.length);
      return;
    }

    let points;
    try {
      points = list.map((p) => {
        const xy = map.projectToContainer(new TMap.LatLng(p.lat, p.lng));
        return { id: p.id, x: xy.x, y: xy.y };
      });
    } catch {
      return; // 地图还没铺好，等下一次 moveend / zoomend 再算
    }

    const faded = computeFaded(points, highlightRef.current);
    const changed =
      faded.size !== fadedRef.current.size || [...faded].some((id) => !fadedRef.current.has(id));

    if (changed) {
      fadedRef.current = faded;
      paintMarkers();
    }
    reportVisible(list.length - faded.size);
  }, [paintMarkers, reportVisible]);

  useEffect(() => {
    let cancelled = false;

    // 缩放级别决定标记画 pin 还是圆点。
    // zoom_changed 在缩放动画期间会连续触发，但这里只在「跨越 12 级」时才会真正
    // setState（setCompact 传相同值时 React 直接跳过渲染），不会抖。
    // 定义在 effect 作用域而不是 init() 里，卸载时才能 off 掉同一个函数引用。
    const syncCompact = () => {
      const map = mapRef.current;
      const z = typeof map?.getZoom === "function" ? map.getZoom() : 15;
      setCompact(z <= DOT_ZOOM_MAX);
    };

    async function init() {
      try {
        await loadTMapSdk();
        if (cancelled || !containerRef.current || !window.TMap) return;
        // 已经有实例就绝不再建：重建会闪烁、丢缩放、泄漏
        if (mapRef.current) return;

        const TMap = window.TMap;

        const map = new TMap.Map(containerRef.current, {
          center: new TMap.LatLng(centerRef.current.lat, centerRef.current.lng),
          zoom: 15,
          // 不传 mapStyleId、不调用 TMap.setConfig()：只用官方默认样式
        });
        mapRef.current = map;

        // 图层只建一次，之后靠 setGeometries 换内容（不要每帧 new 图层）
        markersRef.current = new TMap.MultiMarker({
          map,
          styles: buildMarkerStyles(TMap),
          geometries: [],
          // 点标记的事件不要冒泡到地图：否则「点标记」会连带触发下面的
          // map click（关弹窗），弹窗刚开就被关掉
          isStopPropagation: true,
        });
        circlesRef.current = new TMap.MultiCircle({
          map,
          styles: buildCircleStyles(TMap),
          geometries: [],
        });
        // 景点占地：真实多边形，和标记走同一份数据
        polygonsRef.current = new TMap.MultiPolygon({
          map,
          styles: buildPolygonStyles(TMap),
          geometries: [],
          isStopPropagation: true,
        });
        // 路标单独一层：它不参与淡出、不参与抽样，而且层级要比普通标记高（用户自己放的，
        // 被一堆 POI 盖住就没法拖了）。TMap 的图层顺序按创建顺序，所以最后建。
        waypointLayerRef.current = new TMap.MultiMarker({
          map,
          styles: buildMarkerStyles(TMap),
          geometries: [],
          isStopPropagation: true,
        });

        // 弹窗先建好但不挂 map（不传 map 就不会显示），点开某个点时才挂上去
        infoWindowRef.current = new TMap.InfoWindow({
          position: new TMap.LatLng(centerRef.current.lat, centerRef.current.lng),
          offset: POI_POPUP_OFFSET, // 往上抬 40px，正好落在 34 高的 pin 上方
        });

        // 点标记 → 缩放动画 + 弹窗 + 同线路高亮
        markersRef.current.on("click", (evt) => {
          const id = evt?.geometry?.id;
          if (!id) return;
          const poi = poisRef.current.find((p) => p.id === id);
          if (!poi) return;

          // 放置路标模式下点到标记：就地放一个路标，不要弹窗。
          // 标记图层的点击是 isStopPropagation 的，不在这里拦的话地图根本收不到，
          // 用户会觉得「明明开着放置，点哪儿都没反应」。
          if (waypointModeRef.current) {
            onAddWaypointRef.current?.(poi.lng, poi.lat);
            return;
          }

          // 需求 2.1：0.2 秒内把比例尺推到「10 米」这一档。
          // 腾讯的签名是 easeTo(target, { duration }) —— duration 在第二个参数里，
          // 不是 target 里面（写进 target 会被忽略，变成默认 500ms）。
          map.easeTo(
            { center: new TMap.LatLng(poi.lat, poi.lng), zoom: FOCUS_ZOOM },
            { duration: FOCUS_DURATION_MS },
          );

          // 需求 4：点开一个交通节点后，把同线路的其他节点高亮出来。
          // 判定用的是 poi.lines（OSM route 关系里反查出来的真实线路），
          // 没有任何一条线路信息就不做高亮 —— 宁可不高亮，也不瞎连。
          let hl = new Set();
          if (poi.category === "transit" && Array.isArray(poi.lines) && poi.lines.length) {
            const mine = new Set(poi.lines);
            for (const other of poisRef.current) {
              if (other.id === poi.id) continue;
              if (other.category !== "transit" || !Array.isArray(other.lines)) continue;
              if (other.lines.some((l) => mine.has(l))) hl.add(other.id);
            }
          }
          const changed =
            hl.size !== highlightRef.current.size || [...hl].some((x) => !highlightRef.current.has(x));
          if (changed) {
            highlightRef.current = hl;
            paintMarkers();
            // 高亮的点必须从「淡出」里放出来，否则线路会被切得一段一段
            recomputeDensity();
          }

          // 需求 2.2：在标志旁边弹窗
          const infoWindow = infoWindowRef.current;
          if (infoWindow) {
            openPoiRef.current = poi;
            infoWindow.setPosition(new TMap.LatLng(poi.lat, poi.lng));
            // 上一步点路标时把气泡抬高了 47px，回到普通 POI 要还原，否则气泡会飘在半空
            infoWindow.setOffset?.(POI_POPUP_OFFSET);
            infoWindow.setContent(renderPopup(poi));
            infoWindow.setMap(map);
          }

          onSelect?.(poi);
        });

        // 路标图层上的点击不在这里处理：拖动和点击要区分「有没有移动」，
        // 统一由容器上的指针事件处理（见下面的拖动 effect）。

        // 景点多边形同样是 isStopPropagation 的。放置模式下点在景点范围里，
        // 地图收不到 click、路标就放不下去 —— 这里补一条，取点击处的经纬度。
        polygonsRef.current.on("click", (evt) => {
          if (!waypointModeRef.current) return;
          const ll = evt?.latLng;
          if (!ll) return;
          const lat = typeof ll.getLat === "function" ? ll.getLat() : ll.lat;
          const lng = typeof ll.getLng === "function" ? ll.getLng() : ll.lng;
          onAddWaypointRef.current?.(lng, lat);
        });

        // 点空白处：关弹窗 + 取消高亮；路标模式下则是「在这里放一个路标」
        map.on("click", (evt) => {
          // 上一步刚点的是路标（弹了删除确认），这一下 click 是浏览器补发的，忽略
          if (suppressMapClickRef.current) {
            suppressMapClickRef.current = false;
            return;
          }

          if (waypointModeRef.current) {
            const ll = evt?.latLng;
            if (!ll) return;
            // LatLng 的取值方式在不同版本里可能是属性也可能是方法，两种都认
            const lat = typeof ll.getLat === "function" ? ll.getLat() : ll.lat;
            const lng = typeof ll.getLng === "function" ? ll.getLng() : ll.lng;
            // 注意顺序是 (lng, lat)，和 MapView 里那个函数签名一致（全项目统一 lng 在前）
            onAddWaypointRef.current?.(lng, lat);
            return;
          }

          openPoiRef.current = null;
          infoWindowRef.current?.setMap(null);
          if (highlightRef.current.size) {
            highlightRef.current = new Set();
            paintMarkers();
            recomputeDensity();
          }
        });

        // 缩放级别决定标记画 pin 还是圆点（syncCompact 定义在 effect 顶部）
        map.on("zoom_changed", syncCompact);
        syncCompact();

        // 需求 2 的判定依赖屏幕像素，所以缩放结束和平移结束都要重算：
        // 只算缩放的话，把地图往旁边拖一段，密集区会从别处挪进屏幕却还按旧结果画。
        map.on("zoomend", recomputeDensity);
        map.on("moveend", recomputeDensity);

        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    }

    init();

    return () => {
      cancelled = true;
      // 卸载时销毁，避免切页面泄漏 WebGL 上下文和 DOM
      try {
        mapRef.current?.off?.("zoom_changed", syncCompact);
        mapRef.current?.off?.("zoomend", recomputeDensity);
        mapRef.current?.off?.("moveend", recomputeDensity);
        infoWindowRef.current?.setMap(null);
        infoWindowRef.current?.destroy?.();
        markersRef.current?.setMap(null);
        waypointLayerRef.current?.setMap(null);
        circlesRef.current?.setMap(null);
        polygonsRef.current?.setMap(null);
        mapRef.current?.destroy();
      } catch {
        // 销毁失败不影响页面切换
      }
      infoWindowRef.current = null;
      markersRef.current = null;
      waypointLayerRef.current = null;
      circlesRef.current = null;
      polygonsRef.current = null;
      mapRef.current = null;
      setReady(false);
      // 注意不重置 sdkPromise：SDK 已经下载过，重挂组件不该再插一次 script
    };
    // onSelect 故意不进依赖：它每次渲染都是新函数，进依赖会让整个地图重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 弹窗里的收藏按钮：内容是一段 HTML 字符串，React 管不到它，
  // 只能在整个 document 上统一接住（事件委托）。好处是弹窗内容被 setContent 重建后
  // 也不需要重新绑 —— 委托收的是「冒到顶层的点击」，跟元素是新是旧无关。
  useEffect(() => {
    function onClick(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      // 路标的「删除路标」按钮（需求 6 的删除交互）
      const delButton = target.closest("[data-wp-del]");
      if (delButton) {
        event.stopPropagation();
        const id = Number(delButton.getAttribute("data-wp-del"));
        if (Number.isInteger(id)) {
          waypointAskRef.current = null;
          openPoiRef.current = null;
          infoWindowRef.current?.setMap(null);
          onDeleteWaypointRef.current?.(id);
        }
        return;
      }

      // 打卡按钮（2026-10-29）：POI 弹窗上那一颗。
      // 和收藏一样必须拦在捕获阶段 —— 不拦的话 TMap 会把它当成"点了地图空白"把弹窗关掉。
      const checkButton = target.closest("[data-check-poi]");
      if (checkButton) {
        event.stopPropagation();
        const poiId = checkButton.getAttribute("data-check-poi");
        const source = checkButton.getAttribute("data-check-source");
        const poi = poisRef.current.find((p) => p.id === poiId);
        if (!poi) return;
        onToggleCheckinRef.current?.({ kind: "poi", poi, source });
        return;
      }

      // 打卡按钮（路标气泡上那一颗）。路标不在 poisRef 里，得单独找。
      const checkWp = target.closest("[data-check-wp]");
      if (checkWp) {
        event.stopPropagation();
        const id = Number(checkWp.getAttribute("data-check-wp"));
        if (!Number.isInteger(id)) return;
        const wp = waypointsRef.current.find((w) => w.id === id);
        if (!wp) return;
        onToggleCheckinRef.current?.({ kind: "waypoint", waypoint: wp });
        return;
      }

      const button = target.closest("[data-fav-poi]");
      if (!button) return;

      // 必须拦住，而且要拦在捕获阶段：
      // TMap 把「点地图容器」当成「点了空白处 → 关弹窗」，不拦的话点一下收藏弹窗就没了，
      // 表现就像按钮没反应。捕获阶段在 document 上跑得比地图容器早，能真正挡住。
      event.stopPropagation();

      const poiId = button.getAttribute("data-fav-poi");
      const source = button.getAttribute("data-fav-source");
      const poi = poisRef.current.find((p) => p.id === poiId);
      if (!poi) return;

      // 交给 MapView 去发请求、改 Set，这里只负责把「点了谁」说清楚
      onToggleFavoriteRef.current?.(poi, source);
    }

    document.addEventListener("click", onClick, true);
    // 卸载必须解绑，否则切页面再回来会绑第二份，一次点击发两个请求
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // 收藏状态变了（☆ 点了变 ★）：如果弹窗正开着，就地重画内容，不要关掉再开
  useEffect(() => {
    if (!ready) return;
    const poi = openPoiRef.current;
    const infoWindow = infoWindowRef.current;
    if (!poi || !infoWindow) return;
    infoWindow.setContent(renderPopup(poi));
    // renderPopup 只读 ref，不写进依赖也不会拿到旧值
  }, [ready, favoriteKeys, checkinKeys, dataSource]);

  // 从「我的收藏」点某一项：动画飞过去（第二轮需求 1）
  //
  // 原来是 setCenter + setZoom，等于瞬移，看不出「定位到哪个点」这件事；
  // 改成 easeTo 走一段动画。缩放目标是 FAVORITE_ZOOM（比例尺 100 米 ≈ 400 英尺），
  // 和点标记时的 10 米档分开 —— 收藏夹是用来「找回一个地方」的，不是看门牌号。
  useEffect(() => {
    if (!ready || !focusPoi || !mapRef.current || !window.TMap) return;
    const el = containerRef.current;
    // 一种情况给的是单个点（用固定档位），另一种给的是"要装下这些点的半径"
    // （「显示全部收藏 / 路标」用它换算缩放级别，否则固定档位里根本放不下）。
    const zoom = focusPoi.radius
      ? fitZoom(focusPoi.radius, focusPoi.lat, el?.clientWidth, el?.clientHeight)
      : FAVORITE_ZOOM;
    mapRef.current.easeTo(
      { center: new window.TMap.LatLng(focusPoi.lat, focusPoi.lng), zoom },
      { duration: FAVORITE_DURATION_MS },
    );
  }, [ready, focusPoi]);

  // 退出「特定节点展示」：视野回到刚进页面时的样子（起点为中心 + 这一档时间能到的范围）。
  // 依赖里只放 resetKey/ready —— 其它 props 在 effect 执行时读到的就是当下值，
  // 把它们写进依赖反而会让"切换起点的自动适配"和这里互相打架。
  useEffect(() => {
    if (!ready || !resetKey || !mapRef.current || !window.TMap) return;
    const el = containerRef.current;
    const zoom = fitZoom(
      Number(reach) || Number(radius) || 2000,
      center.lat,
      el?.clientWidth,
      el?.clientHeight,
    );
    mapRef.current.easeTo(
      { center: new window.TMap.LatLng(center.lat, center.lng), zoom },
      { duration: 700 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, resetKey]);

  // 「不显示」模式下唯一要画的那个点。普通模式下恒为 null ——
  // 这样点一下标记（上层会 setSelectedPoi）就不会连带重绘一万多个点。
  const singlePoi = hidden ? selectedPoi : null;

  // 数据 / 筛选变了只更新图层，绝不碰地图实例
  useEffect(() => {
    if (!ready || !window.TMap) return;
    const TMap = window.TMap;

    // 需求 5「不显示」：除了当前打开的那一个点，什么都不画。
    // 传进来的 pois 已经被上层按分类筛过，这里只负责「显示几个」这一层。
    const markerList = hidden ? (singlePoi ? [singlePoi] : []) : pois;
    drawnRef.current = markerList;
    compactRef.current = compact;

    // 每次都给全新的 geometry 数组：传同一个引用，SDK 不认为有变化。
    // 具体样式（正常 / 淡出 / 高亮）由 paintMarkers 决定，这里只负责「有哪些点」。
    paintMarkers();

    // 需求 2：换了数据 / 换了显示模式，密集判定得重算 —— 同一块屏幕上点数变了
    recomputeDensity();

    // 景点占地：需求 2.3「景点类在地图上用蓝色透明色覆盖其范围」。
    // 以前是拿一个编出来的 areaRadius 画圆，现在用 OSM 的真实轮廓（p.area 是
    // [lat, lng] 数组）。没有轮廓的景点就不画 —— 宁可不画，也不编一个范围出来。
    // 「不显示」模式下面也不画：需求原文是「其他节点全部隐藏，仅展示地图」。
    const areaGeometries = hidden
      ? []
      : pois
          .filter((p) => p.category === "attraction" && Array.isArray(p.area) && p.area.length >= 3)
          .map((p) => ({
            id: `area:${p.id}`,
            styleId: "attractionArea",
            // MultiPolygon 的 paths 是「环的数组」，一个闭合环也要包一层
            paths: [p.area.map(([lat, lng]) => new TMap.LatLng(lat, lng))],
          }));

    // MultiCircle 的 center 必须是 TMap.LatLng，radius 必须是数字（不能是字符串）
    const reachM = Number(reach) || Number(radius) || 0;
    const coverageM = Number(radius) || 0;
    const circles = [
      {
        id: "reach",
        styleId: "reach",
        center: new TMap.LatLng(center.lat, center.lng),
        radius: reachM,
      },
    ];
    // 可达范围比数据范围大时（比如骑行一小时能到 15km，数据只有 3.2km），
    // 补一个灰色数据圈。没有它，用户会以为"外圈是空的"是 bug；有了它就一眼看懂：
    // 圈外是真的没数据，不是没画出来。
    if (coverageM > 0 && reachM > coverageM) {
      circles.push({
        id: "coverage",
        styleId: "coverage",
        center: new TMap.LatLng(center.lat, center.lng),
        radius: coverageM,
      });
    }
    circlesRef.current?.setGeometries(circles);
    polygonsRef.current?.setGeometries(areaGeometries);
  }, [ready, pois, hidden, singlePoi, radius, reach, center, compact, paintMarkers, recomputeDensity]);

  // 缩放级别从 pin 切到圆点（或者反过来）时，只换样式，不重算密集判定 ——
  // 判定尺度是「点与点的屏幕距离」，跟图标大小无关，重算反而会让亮点乱换。
  useEffect(() => {
    if (!ready) return;
    compactRef.current = compact;
    paintMarkers();
  }, [ready, compact, paintMarkers]);

  // ── 路标（需求 6）────────────────────────────────────────────
  //
  // 为什么路标用独立图层：它不能参与淡出、不能被抽样，而且必须压在普通 POI 上面
  // —— 用户自己放的东西被一堆点盖住就没法拖，也没法点。
  const paintWaypoints = useCallback(() => {
    const TMap = typeof window === "undefined" ? null : window.TMap;
    const layer = waypointLayerRef.current;
    if (!TMap || !layer) return;

    layer.setGeometries(
      waypointsRef.current.map((wp) => {
        // 拖动中的那个用临时坐标画，松手才落库（不然会先弹回原位再跳过去）
        const pos = draggingRef.current?.id === wp.id ? draggingRef.current : wp;
        return {
          id: `wp:${wp.id}`,
          // 打过卡的路标中心是黄芯（styleId 只有这两个可选，路标图层本来就不参与密度淡出）
          styleId: checkinKeysRef.current?.has(`waypoint:wp:${wp.id}`)
            ? "waypointChecked"
            : "waypoint",
          position: new TMap.LatLng(pos.lat, pos.lng),
          properties: { title: wp.label || "路标" },
        };
      }),
    );
  }, []);

  // 拖动中的路标也要能被命中判定读到，所以同时留一份 ref
  useEffect(() => {
    draggingRef.current = dragging;
    paintWaypoints();
  }, [dragging, paintWaypoints]);

  // 路标列表变了（新增 / 删除 / 撤销）就重画
  useEffect(() => {
    waypointsRef.current = waypoints;
    paintWaypoints();
  }, [waypoints, paintWaypoints]);

  // 打卡状态变了：图钉中心那个洞的颜色要跟着变。
  // 不能只靠上面那两个"数据变了"的 effect —— 打卡不改 pois、不改 waypoints，
  // 数据一个都没动，只有这个 Set 变了。
  useEffect(() => {
    if (!ready) return;
    paintMarkers();
    paintWaypoints();

    // 路标气泡（「要删除这个路标吗」+ 打卡）不在 openPoiRef 那一套里，得单独刷。
    // 不刷的话点了「打卡」，按钮还写着「○ 打卡」，用户以为没生效。
    const askId = waypointAskRef.current;
    const infoWindow = infoWindowRef.current;
    if (askId != null && infoWindow) {
      const wp = waypointsRef.current.find((w) => w.id === askId);
      if (wp) {
        infoWindow.setContent(
          waypointDeleteHtml(wp, { checked: Boolean(checkinKeys?.has(`waypoint:wp:${wp.id}`)) }),
        );
      }
    }
  }, [ready, checkinKeys, paintMarkers, paintWaypoints]);

  // 点一下路标（没拖动）→ 弹「删除这个路标？」。用同一个 InfoWindow，
  // 因为同一时刻只可能有一个气泡，没必要再建一个。
  const askDeleteWaypoint = useCallback((id) => {
    const TMap = typeof window === "undefined" ? null : window.TMap;
    const wp = waypointsRef.current.find((w) => w.id === id);
    const infoWindow = infoWindowRef.current;
    if (!TMap || !wp || !infoWindow) return;

    waypointAskRef.current = id;
    openPoiRef.current = null; // 关掉 POI 弹窗的状态，避免它把内容又改回去
    infoWindow.setPosition(new TMap.LatLng(wp.lat, wp.lng));
    // 路标 pin 是 47 高，气泡要抬到它头顶上（普通 POI 用的是 -40）
    infoWindow.setOffset?.({ x: 0, y: -WAYPOINT_SIZE.height - 4 });
    infoWindow.setContent(waypointDeleteHtml(wp, {
      checked: Boolean(checkinKeysRef.current?.has(`waypoint:wp:${wp.id}`)),
    }));
    infoWindow.setMap(mapRef.current);
  }, []);

  /**
   * 路标的拖动。
   *
   * 为什么不用 SDK 的 drag 事件：MultiMarker 根本没提供（查过它原型上的全部方法，
   * 只有 add/remove/setGeometries/moveAlong 这些），所以只能自己做。
   *
   * 关键在于**抢在 TMap 自己的 mousedown 之前把事件拦掉**：
   * 监听挂在容器的**父元素**、且用捕获阶段 —— 捕获阶段先于目标元素上的监听执行，
   * stopPropagation 才真的能挡住地图开始平移。挂在容器自己身上是挡不住的
   * （同一元素上的监听按注册顺序跑，TMap 先注册，照样会平移）。
   */
  useEffect(() => {
    const el = containerRef.current;
    const wrap = el?.parentElement;
    if (!ready || !el || !wrap) return;

    const localPoint = (event) => {
      const rect = el.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    // 命中判定：路标样式变了之后（36×47 的红色 pin，针尖对准坐标），
    // 不能再按「离坐标 18px 内」算 —— pin 有大半截在坐标**上方**，点在头上会判不中。
    // 改成矩形判定：横向 ±半个宽，纵向从针尖往上整整一个高度，另外往下留 6px 容错。
    const hitTest = (x, y) => {
      const map = mapRef.current;
      const TMap = window.TMap;
      if (!map || !TMap || typeof map.projectToContainer !== "function") return null;

      const halfW = WAYPOINT_SIZE.width / 2 + 2;
      let hit = null;
      let best = Infinity;
      for (const wp of waypointsRef.current) {
        const pos = draggingRef.current?.id === wp.id ? draggingRef.current : wp;
        let p;
        try {
          p = map.projectToContainer(new TMap.LatLng(pos.lat, pos.lng));
        } catch {
          continue;
        }
        const inside =
          Math.abs(p.x - x) <= halfW && y >= p.y - WAYPOINT_SIZE.height && y <= p.y + 6;
        if (!inside) continue;
        // 多个重叠时取图形中心最近的那个
        const d = Math.hypot(p.x - x, p.y - WAYPOINT_SIZE.height / 2 - y);
        if (d < best) {
          best = d;
          hit = wp;
        }
      }
      return hit;
    };

    const onDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const { x, y } = localPoint(event);
      const hit = hitTest(x, y);
      if (!hit) return;

      event.stopPropagation();
      event.preventDefault();
      dragRef.current = { id: hit.id, startX: x, startY: y, moved: false, lng: hit.lng, lat: hit.lat };
      el.style.cursor = "grabbing";
    };

    const onMove = (event) => {
      const d = dragRef.current;
      if (!d) return;
      const { x, y } = localPoint(event);
      if (!d.moved && Math.hypot(x - d.startX, y - d.startY) > 4) d.moved = true;
      if (!d.moved) return;

      const ll = pixelToLatLng(mapRef.current, el, x, y);
      if (!ll) return;
      d.lat = ll.lat;
      d.lng = ll.lng;
      setDragging({ id: d.id, lng: ll.lng, lat: ll.lat });
    };

    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      el.style.cursor = "";

      if (!d.moved) {
        // 没移动 → 这是「再点一次」，进入删除交互
        suppressMapClickRef.current = true;
        askDeleteWaypoint(d.id);

        // 同时做一次聚焦（2026-10-29 新增）：用户点自己放的路标，
        // 要有和「在窗口里点一行」一样的聚焦动画 —— 地图缩到该点，
        // 边框从这枚 pin 的位置长出来飞向地图四边。
        //
        // 起点矩形必须由这里算：MapView 拿不到 pin 的屏幕坐标，
        // 只有持有 map 实例的这一层能 projectToContainer 出来。
        const wp = waypointsRef.current.find((w) => w.id === d.id);
        const map = mapRef.current;
        const el2 = containerRef.current;
        if (wp && map && el2 && window.TMap && typeof map.projectToContainer === "function") {
          try {
            const p = map.projectToContainer(new window.TMap.LatLng(wp.lat, wp.lng));
            const r = el2.getBoundingClientRect();
            onFocusWaypointRef.current?.(wp, {
              left: r.left + p.x - WAYPOINT_SIZE.width / 2,
              top: r.top + p.y - WAYPOINT_SIZE.height,
              width: WAYPOINT_SIZE.width,
              height: WAYPOINT_SIZE.height,
            });
          } catch {
            // 投影失败（地图还没 ready）就只弹删除气泡，聚焦跳过，不影响主流程
          }
        }
        return;
      }
      // 先提交新坐标（上层会乐观更新），再清掉临时位置，避免中间闪一下
      onMoveWaypointRef.current?.(d.id, d.lng, d.lat);
      setDragging(null);
    };

    // mousedown 用捕获，pointermove/up 挂在 window 上：拖到地图外面松手也要能收到
    wrap.addEventListener("mousedown", onDown, true);
    wrap.addEventListener("touchstart", onDown, true);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);

    return () => {
      wrap.removeEventListener("mousedown", onDown, true);
      wrap.removeEventListener("touchstart", onDown, true);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
      el.style.cursor = "";
    };
  }, [ready, askDeleteWaypoint]);

  // 视野 = 起点 + 「这段时间能到多远」。
  // 时间或出行方式一变，可达圈就变；如果视野不跟着调，圈会跑到画外，
  // 用户看到的就是"点了筛选地图一点反应都没有" —— 这正是原来的 bug。
  // 用 easeTo 走 400ms 动画，避免连续点几个选项时画面乱跳。
  useEffect(() => {
    if (!ready || !mapRef.current || !window.TMap) return;
    const el = containerRef.current;
    const zoom = fitZoom(
      Number(reach) || Number(radius) || 2000,
      center.lat,
      el?.clientWidth,
      el?.clientHeight,
    );
    mapRef.current.easeTo(
      { center: new window.TMap.LatLng(center.lat, center.lng), zoom },
      { duration: 400 },
    );
  }, [ready, center, reach, radius]);

  // 数据换了 / 出行方式换了，弹窗要跟着变：
  //   - 出行方式变了，弹窗里的「步行约 12 分钟」得变成「骑行约 4 分钟」
  //   - 时间变了可能换了一批点，原来打开的那个点未必还在
  // 旧写法是一律 `setMap(null)` 把弹窗关掉，用户点一下「骑行」弹窗就没了，
  // 看起来像是操作失败。现在改成「点还在就地重画，点没了才关」。
  useEffect(() => {
    if (!ready) return;
    const poi = openPoiRef.current;
    const infoWindow = infoWindowRef.current;
    if (!poi || !infoWindow) return;

    // 判断依据是「标记还在不在」而不是「数据里还有没有」：
    // 淡出只是换个样式，点本身还在，所以这里看 drawnRef（真正画出来的那批）
    if (!drawnRef.current.some((p) => p.id === poi.id)) {
      openPoiRef.current = null;
      infoWindow.setMap(null);
      return;
    }
    infoWindow.setContent(renderPopup(poi));
    // renderPopup 只读 ref，不写进依赖也不会拿到旧值
  }, [ready, pois, hidden, singlePoi, modeId]);

  return (
    <div className="relative h-full w-full">
      {/* 路标模式下把光标改成十字：不提示的话没人知道"现在点地图能放东西" */}
      <div
        ref={containerRef}
        className="h-full w-full"
        style={waypointMode ? { cursor: "crosshair" } : undefined}
      />

      {error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
          <p className="max-w-xl text-sm leading-6 text-red-600">地图加载失败：{error}</p>
        </div>
      )}
    </div>
  );
}
