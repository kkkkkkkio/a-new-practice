// 从 OpenStreetMap 抓校园周边的 POI，生成和 snapshot-pois.mjs 完全一样的快照 JSON。
//
// 为什么要有这个脚本：腾讯位置服务的 key 每日配额是 200 次，用光之后就只能等第二天；
// 而且实测出现过 limit_pv 直接变成 0（key 没分配到额度）的情况，那不是"等一等"能解决的。
// OSM 是开放数据，不需要 key、没有日配额，界面里那 6 个分类它也都能覆盖。
//
// 本脚本只写**真实数据**：名称、分类、坐标、地址、景点真实轮廓。
// 不生成营业时间、人均消费这类编造字段（早期版本用哈希编过，已整体删除）。
//
// ⚠ 坐标系：OSM 存的是 WGS-84，腾讯地图 GL JS 认的是 GCJ-02（火星坐标）。
//   直接拿来用会整体偏移 500 多米，标记落在隔壁街区。所以每条都要过一遍 wgs84ToGcj02()。
//
// 用法（在项目根目录）：
//   node scripts/snapshot-osm.mjs
//
// 数据来源与许可：© OpenStreetMap contributors，ODbL。
// 抓取时把圆形范围拆成 4 个象限 × 6 个分类 = 24 次 Overpass 查询（带重试和镜像切换），
// 15km 半径顺利时 20~35 分钟，不需要任何账号。中途有分块抓不到就整体放弃、不覆盖现有快照。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { foldAttractions } from "./fold-attractions.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 和腾讯快照保持同一个中心，页面上的四个校门坐标也是围着它写死的
const CENTER = { lng: 116.348, lat: 39.981 };
// 15000m 是为了让「骑行一小时（15km）」也有数据。
// 这个半径已经是北京市区的量级：一个 around:15000 的查询必然超时（实测单象限单分类就 40s+），
// 所以下面把圆拆成四个象限的矩形分批查，最后再用 haversine 把矩形角落裁掉。
const RADIUS_M = 15000;

// 景点轮廓的点数上限。OSM 里公园轮廓常有几百个节点，
// 原样存会让 JSON 膨胀好几倍，而画在地图上根本看不出差别。
const MAX_AREA_POINTS = 60;

// Overpass 会拒绝没有 User-Agent 的请求（实测返回 406 Not Acceptable）。
// 它的使用条款也要求标明客户端，这里照做。
const USER_AGENT = "buaa-poi-demo/1.0 (course project; contact: local)";

const OUT_PATH = resolve(__dirname, "../public/data/pois-snapshot.json");

// ── 坐标系转换：WGS-84 → GCJ-02 ────────────────────────────
// 标准实现（业界叫 eviltransform）。参数是克拉索夫斯基椭球，
// 国测局那套偏移量由下面两个经验多项式算出来，别自己改系数。
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lng, lat) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lng: lng + dLng, lat: lat + dLat };
}

function haversine(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 地铁站判定。两种常见写法都要认：
//   1. railway=station + station=subway（主流）
//   2. public_transport=station + subway=yes（换乘站有时这么标）
// 光有 railway=station 不够 —— 那是火车站（北京北站、清河站），不是地铁站。
function isSubwayStation(tags) {
  const cab = tags.railway === "station" || tags.public_transport === "station";
  return Boolean(cab) && (tags.station === "subway" || tags.subway === "yes");
}

// OSM 的标签 → 项目里的 6 个分类。顺序就是优先级：
// 公交站/地铁站先判（它们偶尔还挂着 shop 标签），咖啡严格按 amenity=cafe。
//
// 2026-10-29（第二轮需求 3）：交通只保留「地铁站」和「公交站」两类。
// 于是这里**不再收** subway_entrance（地铁出入口，实测 864 个，A口/B口/C口 这种），
// 也不再收普通火车站 —— 它们既不是地铁站也不是公交站。
function mapCategory(tags) {
  const { amenity, shop, tourism, leisure, highway } = tags;

  if (highway === "bus_stop" || isSubwayStation(tags)) {
    return "transit";
  }
  if (amenity === "cafe") return "cafe";
  if (
    tourism === "attraction" ||
    tourism === "museum" ||
    tourism === "gallery" ||
    tourism === "viewpoint" ||
    leisure === "park" ||
    leisure === "garden"
  ) {
    return "attraction";
  }
  if (shop === "mall" || shop === "department_store") return "mall";
  if (shop === "supermarket" || shop === "convenience" || shop === "greengrocer") return "market";
  if (
    amenity === "restaurant" ||
    amenity === "fast_food" ||
    amenity === "food_court" ||
    amenity === "ice_cream"
  ) {
    return "restaurant";
  }
  return null;
}

/**
 * 取实体的轮廓（只对景点用）。
 *
 * 查询用的是 `out geom` 而不是 `out center`：需求要「景点用蓝色透明覆盖其范围」，
 * 那这个范围必须是真实的，不是编一个半径。两种实体：
 *   - way：geometry 就是节点数组
 *   - relation（大型公园常是 multipolygon）：几何分散在 members 里，
 *     取点数最多的那条 outer，足够勾轮廓
 * 返回 WGS-84 的 [{lat, lon}, ...]；拿不到就 null（宁可不画，也不编）。
 */
function outlineOf(el) {
  if (el.type === "way" && Array.isArray(el.geometry)) {
    const ring = el.geometry.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
    return ring.length >= 3 ? ring : null;
  }

  if (el.type === "relation" && Array.isArray(el.members)) {
    const outer = el.members
      .filter(
        (m) =>
          m.type === "way" &&
          (m.role === "outer" || !m.role) &&
          Array.isArray(m.geometry) &&
          m.geometry.length >= 3,
      )
      .sort((a, b) => b.geometry.length - a.geometry.length)[0];
    return outer ? outer.geometry : null;
  }

  return null;
}

// 等距抽稀。轮廓用不着三百个点，抽到 60 个肉眼没区别。
function thin(ring, maxPoints) {
  if (ring.length <= maxPoints) return ring;
  const step = ring.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(ring[Math.floor(i * step)]);
  return out;
}

// ── 线路索引：站点 id → 几号线 / 几路 ───────────────────────────
//
// 站点自己身上没有线路字段：7446 个公交站里带 route_ref 的只有 622 个，而且
// 全是出入口的字母编号（ref=A/B/C）。线路信息只存在于 route 关系里：
//   relation["route"="bus"]     ref=982  name="982路：北京西站南广场 -> 土井村西口"
//   relation["route"="subway"]  ref=4    name="地铁 4号线: 公益西桥 -> 安河桥北"
// 关系的成员就是沿途站点，所以把成员反着建成「站点 id → 线路集合」。
// 实测站点的命中率 95.3%，剩下 4.7% 是关系里没收录的临时站/招呼站。
const MAX_LINES_PER_STOP = 12;

function lineLabel(tags) {
  const ref = String(tags.ref ?? "").trim();
  if (!ref) return null;

  if (tags.route === "subway") {
    // ref 可能是 "4"、"13"、"4/大兴线"，取前面那段；机场线这类没有数字的原样用
    const n = ref.split("/")[0].trim();
    if (!n) return null;
    return /^\d+$/.test(n) ? `${n}号线` : n;
  }
  if (tags.route === "bus") {
    return /路$/.test(ref) ? ref : `${ref}路`;
  }
  return null;
}

function buildLineIndex(elements) {
  const byId = new Map();
  // 地铁专用：id → 线路。地铁站只能按名字对齐（见下面的 byName），
  // 但名字索引必须**只收地铁线路关系里的站**，否则「知春路」这个同名公交站的
  // 386路、579路… 全都会算到地铁站头上（第一版就是这么错的）。
  const subwayById = new Map();
  const byName = new Map();

  for (const el of elements) {
    if (el.type !== "relation") continue;
    const tags = el.tags ?? {};
    if (tags.route !== "bus" && tags.route !== "subway") continue;

    const label = lineLabel(tags);
    if (!label) continue;

    for (const m of el.members ?? []) {
      if (m.type !== "node" && m.type !== "way") continue;
      const key = `${m.type}/${m.ref}`;
      if (!byId.has(key)) byId.set(key, new Set());
      byId.get(key).add(label);
      if (tags.route === "subway") {
        if (!subwayById.has(key)) subwayById.set(key, new Set());
        subwayById.get(key).add(label);
      }
    }
  }

  // 第二遍：把带回标签的停靠点节点按名字登记 —— 只登记地铁的
  for (const el of elements) {
    if (el.type !== "node") continue;
    const lines = subwayById.get(`node/${el.id}`);
    if (!lines?.size) continue;
    const name = el.tags?.["name:zh"] || el.tags?.name;
    if (!name) continue;
    const key = normalizeStationName(name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, new Set());
    for (const l of lines) byName.get(key).add(l);
  }

  return { byId, subwayById, byName };
}

/**
 * 站名归一化：把「西土城站」「西土城（地铁）」「西土城站台」统一成「西土城」。
 *
 * 地铁站节点和停靠点节点在 OSM 里各写各的，后缀不一致很常见（同一座车站在两处
 * 可能一个叫「知春路」一个叫「知春路站」）。不归一化的话按名字对不上。
 */
function normalizeStationName(name) {
  return String(name ?? "")
    .replace(/[（(][^）)]*[）)]/g, "") // 去掉括号里的注释（换乘、方向之类）
    .replace(/(地铁站|地铁|站台|车站|公交站|站)$/g, "")
    .trim();
}

// 线路排序：2 号线排在 10 号线前面（按数字比，不按字符串比），
// 没有数字的（机场线）排最后 —— 直接 localeCompare 会把 "10号线" 排在 "2号线" 前面。
function sortLines(list) {
  return [...list].sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    const fa = Number.isFinite(na);
    const fb = Number.isFinite(nb);
    if (fa && fb && na !== nb) return na - nb;
    if (fa !== fb) return fa ? -1 : 1;
    return a.localeCompare(b, "zh");
  });
}

// ── 抓取：一个分类一次查询，带重试 + 镜像切换 ─────────────────
//
// 以前是「一个查询里塞 6 个分类」。半径 3200m 时这样还行（一次 40s），
// 但半径一放大就特别容易挂：实测 6000m 时 4 次尝试全部失败
// （overpass-api.de 回 502、kumi 镜像 110s 后 504）。原因是单次查询太重，
// 公益服务器扛不住。拆开之后每次只查一类，单次几秒到二十秒，
// 失败也只影响那一类，重试成本低得多。
// 一个分类一次查询。2026-10-29 第二轮需求又加了两条「线路」查询：
// 站点自己身上没有「几号线 / 几路」这个字段（实测 7446 个公交站里带 route_ref 的只有 622 个，
// 而且都是出入口的字母编号），线路只在 route 关系的成员里。所以额外把地铁/公交线路关系
// 也抓下来，回头用「成员节点 id → 线路」反查。站点命中率实测 95.3%。
//
// `out` 不一样：站点要 out geom tags（要坐标要标签），而线路关系必须用 out body ——
// 一条公交线路有几百个成员，带 geometry 的话单块能到几十 MB（实测 325 条线路 2.7MB，
// 带 geom 估计 60MB+）。
const CATEGORY_QUERIES = [
  { label: "餐饮", filter: 'nwr["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream)$"]' },
  { label: "商超", filter: 'nwr["shop"~"^(supermarket|convenience|mall|department_store|greengrocer)$"]' },
  { label: "景点", filter: 'nwr["tourism"~"^(attraction|museum|gallery|viewpoint)$"]' },
  { label: "公园", filter: 'nwr["leisure"~"^(park|garden)$"]' },
  { label: "公交站", filter: 'nwr["highway"="bus_stop"]' },
  // 只查 railway=station：subway_entrance（出入口）以前也收，第二轮需求明确
  // 「交通只保留地铁站和公交站」，出入口既不是站也不是公交，全部不收。
  // 顺带的好处是这一块的查询量和数据量都小了一个量级。
  { label: "地铁车站", filter: 'nwr["railway"="station"]' },
  // 地铁线路要多拿一样东西：线路关系的成员是**站台停靠点**（role=stop 的节点），
  // 不是 `railway=station` 那个站点节点 —— 两者在 OSM 里是两个对象，靠 id 对不上
  // （实测 273 个地铁站只有 5 个能按 id 命中）。所以这条查询用「先取关系、再取它的
  // stop 成员」的写法，把停靠点的**标签**一起拿回来，回头按站名对齐。
  {
    label: "地铁线路",
    raw: 'relation["route"="subway"]({{BBOX}})->.r;\n(.r; node(r.r:"stop"););',
    out: "out body;",
  },
  { label: "公交线路", filter: 'relation["route"="bus"]', out: "out body;" },
];

// 镜像按顺序试。注意 attempts 不一样：
//   - overpass-api.de 顶不住时是**秒回 502**（0.2~1s），几乎不花时间，可以多试几次；
//   - kumi 现在是不响应（要等满 120s 超时），只在最后试一次，免得白等。
// 2026-10-29 实测：一次失败块在 kumi 上先后吃掉 120s + 110s，绝大部分时间都耗这儿。
const MIRRORS = [
  { url: "https://overpass-api.de/api/interpreter", attempts: 3 },
  { url: "https://overpass.kumi.systems/api/interpreter", attempts: 1 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 硬超时。
 *
 * 为什么要自己写一层：2026-10-29 实测，Overpass 无响应时
 * `AbortSignal.timeout(...)` 在这台机器的代理链路下**不会真正中断连接** ——
 * 有一块查询硬生生挂了 7338 秒（2 小时）才抛 TypeError。所以这里用
 * Promise.race 跟一个定时器赛跑，超时就当失败处理，绝不让整轮任务卡死。
 */
function withHardTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HARD_TIMEOUT_${Math.round(ms / 1000)}s_${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 单次请求的硬上限。正常一块 30~45s，给到 120s 足够；再久基本就是挂了。
const REQUEST_TIMEOUT_MS = 120000;

// 分块结果落盘：网络这么不稳，一轮跑不完是常态。
// 把每次成功的小块存下来，下次重跑自动跳过，可以分几次攒齐再合并。
// 必须带上 radius + filter 指纹：改了半径或过滤条件，旧块就不能再用了。
const BLOCK_DIR = resolve(__dirname, "../.data/osm-blocks");

function blockPath(radius, filter, areaLabel, catLabel) {
  const safe = (s) => s.replace(/[^\w\u4e00-\u9fa5-]/g, "_");
  return resolve(BLOCK_DIR, `${radius}-${safe(areaLabel)}-${safe(catLabel)}-${hash(filter)}.json`);
}

// 极简字符串指纹，只用来区分不同过滤条件，不做安全用途
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function readBlock(file) {
  if (!existsSync(file)) return null;
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(json.elements) ? json : null;
  } catch {
    return null; // 半个文件（上次被强杀）就当没有
  }
}

function writeBlock(file, elements) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), elements }), "utf8");
}

// ── 按象限切块 ────────────────────────────────────────────────
//
// 15km 的 around 查询单个必然超时（实测单象限单分类就要 40s+），所以改成
// 四个矩形分块：每块是外接正方形的四分之一，查完再用 haversine 把角落裁掉。
// 相邻块在中心线与中心点上有重叠，靠后面的 byId 去重，不影响结果。
const D_LAT = RADIUS_M / 110540; // 纬度方向 15km 差多少度
const D_LNG = RADIUS_M / (111320 * Math.cos((CENTER.lat * Math.PI) / 180));

const AREAS = [
  { label: "西北", bbox: [CENTER.lat, CENTER.lng - D_LNG, CENTER.lat + D_LAT, CENTER.lng] },
  { label: "东北", bbox: [CENTER.lat, CENTER.lng, CENTER.lat + D_LAT, CENTER.lng + D_LNG] },
  { label: "西南", bbox: [CENTER.lat - D_LAT, CENTER.lng - D_LNG, CENTER.lat, CENTER.lng] },
  { label: "东南", bbox: [CENTER.lat - D_LAT, CENTER.lng, CENTER.lat, CENTER.lng + D_LNG] },
];

// bbox 的顺序是 (南, 西, 北, 东)
//
// 两种写法：普通分类给 filter，拼成 `filter(bbox);`；
// 需要多语句的（地铁线路）给 raw，里面的 {{BBOX}} 会被替换掉。
function buildQuery(cat, bbox) {
  const body = cat.raw
    ? cat.raw.replace("{{BBOX}}", bbox.join(","))
    : `${cat.filter}(${bbox.join(",")});`;
  return `[out:json][timeout:170];
${body}
${cat.out ?? "out geom tags;"}`;
}

async function fetchElements(cat, bbox, tag, cacheFile) {
  const { label } = cat;
  for (const mirror of MIRRORS) {
    const host = new URL(mirror.url).host;
    for (let attempt = 1; attempt <= mirror.attempts; attempt++) {
      const t0 = Date.now();
      try {
        const res = await withHardTimeout(
          fetch(mirror.url, {
            method: "POST",
            headers: {
              "User-Agent": USER_AGENT,
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json",
            },
            body: new URLSearchParams({ data: buildQuery(cat, bbox) }),
          }),
          REQUEST_TIMEOUT_MS,
          label,
        );
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (!res.ok) {
          console.warn(`  ${tag} ${label} @ ${host} 第${attempt}次：HTTP ${res.status}（${secs}s）`);
          await sleep(3000);
          continue;
        }
        const text = await withHardTimeout(res.text(), 60000, `${label}-body`);
        const json = JSON.parse(text);
        const elements = Array.isArray(json.elements) ? json.elements : [];
        console.log(`  ${tag} ${label} @ ${host} 第${attempt}次：${elements.length} 个元素（${secs}s）`);
        // 落盘，下次重跑不用再查这块
        writeBlock(cacheFile, elements);
        return elements;
      } catch (e) {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        console.warn(`  ${tag} ${label} @ ${host} 第${attempt}次：${e?.name || e}（${secs}s）`);
        await sleep(3000);
      }
    }
  }
  return null;
}

const startedAt = Date.now();
const totalJobs = AREAS.length * CATEGORY_QUERIES.length;
console.log(
  `查询 Overpass：以 (${CENTER.lng}, ${CENTER.lat}) 为圆心 ${RADIUS_M}m，` +
    `拆成 ${AREAS.length} 个象限 × ${CATEGORY_QUERIES.length} 个分类 = ${totalJobs} 次查询 ……`,
);

const elements = [];
let done = 0;

const jobs = [];
for (const area of AREAS) {
  for (const cat of CATEGORY_QUERIES) jobs.push({ area, cat });
}

// 单块抓取：先查本地缓存，没有再打网络
async function fetchJob(area, cat, tag) {
  const cacheFile = blockPath(RADIUS_M, cat.raw ?? cat.filter, area.label, cat.label);
  const cached = readBlock(cacheFile);
  if (cached) {
    console.log(`  ${tag} ${area.label} ${cat.label}：用本地缓存（${cached.elements.length} 个元素）`);
    return cached.elements;
  }
  return fetchElements(cat, area.bbox, `${tag} ${area.label}`, cacheFile);
}

// 把一块对半切成四块（南北 × 东西）
function splitArea(area) {
  const [s, w, n, e] = area.bbox;
  const midLat = (s + n) / 2;
  const midLng = (w + e) / 2;
  return [
    { label: `${area.label}1`, bbox: [midLat, w, n, midLng] },
    { label: `${area.label}2`, bbox: [midLat, midLng, n, e] },
    { label: `${area.label}3`, bbox: [s, w, midLat, midLng] },
    { label: `${area.label}4`, bbox: [s, midLng, midLat, e] },
  ];
}

/**
 * 抓一块，失败就切小再抓。
 *
 * 为什么要切：Overpass 按「查询成本」限流，商超/景点这两类用的是正则匹配
 * （`shop~"^(supermarket|…)$"`），在密集城区整块查会被网关直接 502/504 拒掉 ——
 * 实测西北块能过、东北/西南同样大小的块就过不了。块越小成本越低，这是官方推荐做法。
 * 已经成功的子块会落盘，下次重跑直接跳过。
 */
async function fetchDeep(area, cat, depth, tag) {
  const got = await fetchJob(area, cat, tag);
  if (got) return got;
  if (depth <= 0) return null;

  const subs = splitArea(area);
  console.log(`  ${tag} ${area.label} ${cat.label} 失败 → 切成 ${subs.length} 小块（还剩 ${depth - 1} 层）`);
  const out = [];
  for (const sub of subs) {
    const part = await fetchDeep(sub, cat, depth - 1, tag);
    // 少一块都不行：宁可整体失败重来，也不写一份某片区整片空掉的快照
    if (!part) return null;
    out.push(...part);
  }
  return out;
}

// 第一遍：整块抓
let pending = [];
for (const job of jobs) {
  done++;
  const got = await fetchJob(job.area, job.cat, `[${done}/${jobs.length}]`);
  if (got) elements.push(...got);
  else pending.push(job);
}

// 第二遍：失败的整块切开重抓（最多切两层，最细到 3.75km）
const MAX_SPLIT_DEPTH = 2;
if (pending.length) {
  console.log(`\n还有 ${pending.length} 块整块查不动，开始切分重试 ……`);
  const still = [];
  for (const job of pending) {
    const got = await fetchDeep(job.area, job.cat, MAX_SPLIT_DEPTH, "[切分]");
    if (got) elements.push(...got);
    else still.push(job);
  }
  pending = still;
}

// 少一块就宁可不写：残缺快照会让某一片区域整片空掉，比失败更难发现。
if (pending.length) {
  console.error(
    `\n这些分块没抓到：${pending.map((p) => `${p.area.label}/${p.cat.label}`).join("、")}。` +
      `为避免写入残缺快照，本次不覆盖现有文件。已成功的块留在 .data/osm-blocks/，重跑会跳过。`,
  );
  process.exit(1);
}

console.log(`\n共拿到 ${elements.length} 个元素（${((Date.now() - startedAt) / 1000).toFixed(1)}s）\n`);

// 先把线路关系整理成「站点 id → 线路」，再逐条入库时反查
const lineIndex = buildLineIndex(elements);

const byId = new Map();
let skippedNoName = 0;
let skippedFar = 0;
let withArea = 0;
let attractionTotal = 0;

for (const el of elements) {
  const tags = el.tags ?? {};
  const category = mapCategory(tags);
  if (!category) continue;

  // 名字取不到就不收：界面上会显示成"未命名地点"，点开也没东西，不如不要
  // 中文名优先：OSM 里不少景点主 name 是英文（比如颐和园的长廊叫 "Long corridor"），
  // 中文界面里看着很跳；name:zh 是同一个地方的中文写法，属于真实字段，不是编的。
  const name = tags["name:zh"] || tags.name || tags["name:en"];
  if (!name) {
    skippedNoName++;
    continue;
  }

  // 轮廓对所有类型都要算（只是最后只有景点会存进去）：
  // 商场、超市、餐厅也常被映射成 way（整栋楼），这类实体没有 lat/lon，
  // 不拿轮廓就没有坐标、整条会被扔掉 —— 实测会少掉 50 多条。
  const outline = outlineOf(el);

  // 位置：node 自带 lat/lon；way/relation 用轮廓的顶点平均（比包围盒中心更贴合形状）
  let wgsLat;
  let wgsLng;
  if (Number.isFinite(el.lat)) {
    wgsLat = el.lat;
    wgsLng = el.lon;
  } else if (outline) {
    wgsLat = outline.reduce((s, p) => s + p.lat, 0) / outline.length;
    wgsLng = outline.reduce((s, p) => s + p.lon, 0) / outline.length;
  } else {
    continue;
  }

  // 关键一步：转成 GCJ-02 再入库
  const { lng, lat } = wgs84ToGcj02(wgsLng, wgsLat);
  if (haversine({ lng, lat }, CENTER) > RADIUS_M) {
    skippedFar++;
    continue;
  }

  // id 用 OSM 的 "类型/编号"，可回溯；前缀防止和其他数据源撞号
  const id = `osm:${el.type}/${el.id}`;

  const poi = {
    id,
    name,
    category,
    lng: Number(lng.toFixed(6)),
    lat: Number(lat.toFixed(6)),
  };

  // 地址只在 OSM 真的写了门牌时才带，不编
  const address = [tags["addr:street"] ?? "", tags["addr:housenumber"] ?? ""]
    .filter(Boolean)
    .join(" ");
  if (address) poi.address = address;

  if (category === "attraction") attractionTotal++;

  // 交通的两类：地铁站 / 公交站。kind 只是交通内部的细分，
  // category 仍然是 transit —— 收藏表的 category 枚举不变，老数据不用迁移。
  if (category === "transit") {
    const isBus = tags.highway === "bus_stop";
    poi.kind = isBus ? "bus" : "subway";

    // 两条路：先按 id 找（公交站就是关系成员本身，实测 95% 命中）；
    // 找不到再按站名找（地铁站只能这么办 —— 它和线路关系的成员是两个对象）。
    // 地铁站先查 subwayById：万一它自己也是某条公交线的站台成员，
    // 也不能把公交线路算进「地铁几号线」里。
    let lines;
    if (isBus) {
      lines = lineIndex.byId.get(`${el.type}/${el.id}`);
    } else {
      lines =
        lineIndex.subwayById.get(`${el.type}/${el.id}`) ??
        lineIndex.byName.get(normalizeStationName(name));
    }
    if (lines?.size) {
      // 一个站可能被十几条线路经过（西苑、西直门），全列出来弹窗会被撑爆
      poi.lines = sortLines(lines).slice(0, MAX_LINES_PER_STOP);
    }
  }

  // 景点轮廓：真实多边形，每个点都转过坐标系。用 [lat, lng] 数组压体积。
  // 其它分类不存轮廓（画面上用不到，白占体积）。
  if (outline && category === "attraction") {
    poi.area = thin(outline, MAX_AREA_POINTS).map((p) => {
      const g = wgs84ToGcj02(p.lon, p.lat);
      return [Number(g.lat.toFixed(6)), Number(g.lng.toFixed(6))];
    });
    withArea++;
  }

  byId.set(id, poi);
}

// 景区里的小景点并进父景区（颐和园里的铜牛、文昌阁、谐趣园……都在这一步收起来）。
// 逻辑和判据全在 fold-attractions.mjs 里，这里只负责调用和记账。
const folded = foldAttractions([...byId.values()]);
byId.clear();
for (const p of folded.pois) byId.set(p.id, p);
const kept = [...byId.values()];

if (kept.length < 50) {
  console.error(`只拿到 ${kept.length} 条，太少，不覆盖现有快照。检查一下网络或 Overpass 状态。`);
  process.exit(1);
}

kept.sort((a, b) => haversine(a, CENTER) - haversine(b, CENTER));

const snapshot = {
  _note:
    "地点数据来自 OpenStreetMap（© OpenStreetMap contributors，ODbL），坐标已从 WGS-84 转成 GCJ-02。" +
    "只含真实字段：名称/分类/坐标/地址/景点轮廓；不含营业时间、人均消费等编造信息。" +
    "景点若位于更大的景区范围内（如颐和园里的文昌阁），已并入父景区的 contains 字段，不再单独占标记。" +
    "交通只有地铁站和公交站两类，kind 区分 subway/bus，lines 是途经线路（来自 OSM route 关系）。" +
    "由 scripts/snapshot-osm.mjs 生成。",
  source: "openstreetmap",
  attribution: "© OpenStreetMap contributors, ODbL",
  center: CENTER,
  coverRadius: RADIUS_M,
  capturedAt: new Date().toISOString(),
  pois: kept,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

const stats = {};
for (const p of kept) stats[p.category] = (stats[p.category] || 0) + 1;
const near = (m) => kept.filter((p) => haversine(p, CENTER) <= m).length;

console.log("────────────");
console.log(`共 ${kept.length} 个地点 -> ${OUT_PATH}`);
console.log(`分类：${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`按距离：500m 内 ${near(500)}，1km 内 ${near(1000)}，2km 内 ${near(2000)}`);
// 交通细分：地铁/公交两类各自多少，其中多少带得出线路
const transit = kept.filter((p) => p.category === "transit");
const subwayN = transit.filter((p) => p.kind === "subway").length;
const busN = transit.filter((p) => p.kind === "bus").length;
const withLinesN = transit.filter((p) => p.lines?.length).length;
console.log(
  `交通：地铁站 ${subwayN} + 公交站 ${busN} = ${transit.length}，` +
    `其中 ${withLinesN} 个带线路信息（${((withLinesN / Math.max(1, transit.length)) * 100).toFixed(1)}%）`,
);
console.log(`景点轮廓：${withArea}/${attractionTotal} 个有真实多边形（折叠前）`);
console.log(
  `景区折叠：${folded.removedCount} 个小景点并进 ${folded.folded.length} 个景区，` +
    `同名重复点去重 ${folded.dedupedCount} 个`,
);
if (folded.folded.length) {
  console.log(
    `  收得最多的：${folded.folded
      .slice(0, 6)
      .map((f) => `${f.parent}(${f.children})`)
      .join("、")}`,
  );
}
console.log(`跳过：没名字 ${skippedNoName}，超出半径 ${skippedFar}`);
console.log(`JSON 约 ${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB（字符数）`);
