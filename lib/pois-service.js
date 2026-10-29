// 数据来源编排：缓存 → 腾讯周边搜索 → （没 key 或上游失败就）降级读 mock。
// 只被 Route Handler 调用，不参与任何前端代码。

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
// 注意这里要写全 .js 后缀：Next 的打包器允许省略，但 scripts/ 下的脚本是
// 直接用 node 跑的，Node 的 ESM 解析不认无扩展名的相对导入。
import { CATEGORIES, mapTencentCategory } from "./categories.js";
// 已不再 import poi-extras：营业时间/人均消费/景点半径都是编的，项目只允许真实字段。

const WS_URL = "https://apis.map.qq.com/ws/place/v1/search";
const UPSTREAM_TIMEOUT_MS = 5000;

// 腾讯 boundary=nearby(lat,lng,radius) 的 radius 只允许 10~1000。
// 所以接口虽然接受 5000，真正打上游时必须夹到 1000，超过的部分靠「多点采样」补覆盖。
const UPSTREAM_MAX_RADIUS = 1000;
const PAGE_COUNT = 2; // 单页最多 20 条，翻两页每类最多 40 条
const PAGE_SIZE = 20;

export class PoisError extends Error {
  constructor(code, message, { httpStatus = 500, detail = "" } = {}) {
    super(message);
    this.name = "PoisError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

// 球面距离，单位米。distance 字段一律由坐标算出来，绝不用上游/手写的值，
// 因为采样中心可能不是请求中心，_distance 的参照点会变。
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

const M_PER_DEG_LAT = 110540;
const mPerDegLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

/**
 * 采样中心：半径 <= 1000m 时只查一次；超过时在四周各补一个中心。
 *
 * 偏移量 = radius - 1000，这样最外侧采样圆的边界刚好压到 radius 上，
 * 边缘不会留空白。之前的写法（radius-500）在 2200m 时只覆盖到 2000m，周边一圈是空的。
 */
function buildCenters(lng, lat, radius) {
  if (radius <= UPSTREAM_MAX_RADIUS) return [{ lng, lat }];

  // 上限 1400：再往外铺就离中心太远，中间反而漏得更多
  const offsetM = Math.min(radius - UPSTREAM_MAX_RADIUS, 1400);
  const dB = offsetM / mPerDegLng(lat);
  const dA = offsetM / M_PER_DEG_LAT;

  return [
    { lng, lat },
    { lng, lat: lat + dA }, // 北
    { lng, lat: lat - dA }, // 南
    { lng: lng + dB, lat }, // 东
    { lng: lng - dB, lat }, // 西
  ];
}

// 把腾讯的中文错误信息翻成人话，错误码只进服务端日志，不甩给前端
function friendlyMessage(status, message) {
  const text = String(message ?? "");
  // 配额判断必须放最前面：腾讯的原文是「此key每日调用量已达到上限」，
  // 里面也有 "key"，先判 key 就会误报成密钥问题（实测踩过）
  if (/配额|调用量|上限|超出|超过|limit/i.test(text)) {
    return "腾讯位置服务今日调用量已用完，请明天再试，或在控制台提升配额";
  }
  if (/key|鉴权|签名|权限|授权|域名|来源|白名单|IP/i.test(text)) {
    return "腾讯地图 key 无效、未开通 WebServiceAPI，或授权 IP / 域名不含本机，请到控制台检查该 key 的配置";
  }
  if (/参数|param/i.test(text)) {
    return "上游拒绝了查询参数，请检查中心点坐标是否在服务范围内";
  }
  return "腾讯位置服务暂时不可用，请稍后再试";
}

// 腾讯限的是「每秒请求数」（limit_qps=5），光把并发压到 2 没用 ——
// 每个请求只要 100~200ms，2 个并发照样能打到每秒十几个，直接被 120 拒掉。
// 这里做真正的速率闸：所有上游请求排队，相邻两次发起至少隔 210ms（≈4.7 次/秒）。
let nextSlotAt = 0;

async function throttle() {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + 210;
  const wait = slot - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

// 熔断：上游明确拒绝过之后，短时间内别再往上打。
// 继续打既拿不到数据，还会把限流窗口踩得更死（今天就是这样把 200 次额度烧完的）。
//   - 日配额用完（121）：等不到当天恢复，冷却 10 分钟，期间直接走降级
//   - 每秒超限（120）：缓 3 秒就够，属于瞬时拥塞
const COOLDOWN_QUOTA_MS = 10 * 60 * 1000;
const COOLDOWN_QPS_MS = 3 * 1000;
let cooldownUntil = 0;
let cooldownReason = "";

function tripCooldown(status) {
  if (status === 121) {
    cooldownUntil = Date.now() + COOLDOWN_QUOTA_MS;
    cooldownReason = "腾讯位置服务今日调用量已用完，请明天再试，或在控制台提升配额";
  } else if (status === 120) {
    cooldownUntil = Date.now() + COOLDOWN_QPS_MS;
    cooldownReason = "腾讯位置服务请求过于频繁，稍等几秒再试";
  }
}

async function callSearch({ key, keyword, center, radius, page }) {
  // 熔断期内直接抛，连 URL 都不用拼
  if (Date.now() < cooldownUntil) {
    throw new PoisError("UPSTREAM_COOLDOWN", cooldownReason, { httpStatus: 429 });
  }

  const url = new URL(WS_URL);
  url.searchParams.set("key", key);
  url.searchParams.set("keyword", keyword);
  // auto_extend 传 0：不要自动扩大到 1km/2km/5km，否则会混进圈外的点
  url.searchParams.set(
    "boundary",
    `nearby(${center.lat},${center.lng},${Math.min(radius, UPSTREAM_MAX_RADIUS)},0)`,
  );
  url.searchParams.set("page_size", String(PAGE_SIZE));
  url.searchParams.set("page_index", String(page));
  url.searchParams.set("orderby", "_distance");

  let res;
  try {
    await throttle(); // 发请求前先排队，别突破每秒上限
    res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new PoisError("UPSTREAM_TIMEOUT", "腾讯位置服务响应超时（5 秒），请稍后再试", {
        httpStatus: 504,
        detail: String(error),
      });
    }
    throw new PoisError("UPSTREAM_ERROR", "连不上腾讯位置服务，请检查网络", {
      httpStatus: 502,
      detail: String(error),
    });
  }

  if (!res.ok) {
    throw new PoisError("UPSTREAM_ERROR", "腾讯位置服务返回异常，请稍后再试", {
      httpStatus: 502,
      detail: `HTTP ${res.status}`,
    });
  }

  const json = await res.json();
  if (json.status !== 0) {
    tripCooldown(json.status); // 120/121 会开冷却，后面的请求就不用再白打一遍了
    throw new PoisError("UPSTREAM_ERROR", friendlyMessage(json.status, json.message), {
      httpStatus: 502,
      detail: `status=${json.status} message=${json.message}`,
    });
  }

  return Array.isArray(json.data) ? json.data : [];
}

// 腾讯对每个 key 每个接口的并发上限是 5 次/秒，五类一起 Promise.all 正好压在线上，
// 多一个请求就会报「每秒请求量达到上限」。这里限成 2 个并发，稳。
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

async function fetchFromTencent({ key, lng, lat, radius }) {
  const centers = buildCenters(lng, lat, radius);
  const requestCenter = { lng, lat };
  const byId = new Map();

  for (const [index, center] of centers.entries()) {
    // 中心点查 2 页，周边补的采样点各查 1 页就够了 —— 控制上游请求量
    // （radius=2000 时是 5 个中心，最坏 5 类 ×(2+4×1)=30 个请求）
    const pages = index === 0 ? PAGE_COUNT : 1;
    // 同一个中心下，五个分类按 2 个并发跑；不同中心串行
    const batches = await mapWithConcurrency(CATEGORIES, 2, async (category) => {
      const out = [];
      for (let page = 1; page <= pages; page++) {
        const items = await callSearch({
          key,
          keyword: category.keyword,
          center,
          radius,
          page,
        });
        out.push(...items.map((item) => ({ item, keywordCategory: category.id })));
        if (items.length < PAGE_SIZE) break; // 没有下一页了
      }
      return out;
    });

    for (const { item, keywordCategory } of batches.flat()) {
      const itemLng = Number(item.location?.lng);
      const itemLat = Number(item.location?.lat);
      if (!Number.isFinite(itemLng) || !Number.isFinite(itemLat)) continue;

      // 优先按腾讯自己的 category 归类，认不出来就归到搜索它的那个 keyword 分类
      const category = mapTencentCategory(item.category) ?? keywordCategory;
      const distance = Math.round(haversine({ lng: itemLng, lat: itemLat }, requestCenter));
      if (distance > radius) continue;
      if (byId.has(item.id)) continue;

      byId.set(item.id, {
        id: item.id,
        name: item.title || "未命名地点",
        category,
        lng: itemLng,
        lat: itemLat,
        address: item.address || "",
        distance,
      });
    }
  }

  return [...byId.values()].sort((a, b) => a.distance - b.distance);
}

// 没配 key 时的降级数据源：直接读 public 下的 mock。
// 注意是读磁盘而不是 fetch 自己的接口，避免自己请求自己。
async function fetchFromMock({ lng, lat, radius }) {
  const file = resolve(process.cwd(), "public", "mock", "pois.json");
  const raw = await readFile(file, "utf8");
  const json = JSON.parse(raw);
  const requestCenter = { lng, lat };
  const byId = new Map();

  for (const poi of json.pois ?? []) {
    const distance = Math.round(haversine({ lng: poi.lng, lat: poi.lat }, requestCenter));
    if (distance > radius) continue;
    byId.set(poi.id, { ...poi, distance });
  }

  return [...byId.values()].sort((a, b) => a.distance - b.distance);
}

// ─────────────────────────────────────────────────────────────
// 本地快照：scripts/snapshot-pois.mjs 一次性抓下来的真实 POI，
// 存成 public/data/pois-snapshot.json。存在时它就永远是最优先的数据源 ——
// 零网络调用、不受每日 200 次额度限制、也不会 7 天过期。
// ─────────────────────────────────────────────────────────────
const SNAPSHOT_PATH = resolve(process.cwd(), "public", "data", "pois-snapshot.json");

let snapshotData = null;
let snapshotStamp = "";

export function hasSnapshot() {
  return existsSync(SNAPSHOT_PATH);
}

async function loadSnapshot() {
  if (!existsSync(SNAPSHOT_PATH)) {
    snapshotData = null;
    snapshotStamp = "";
    return null;
  }

  // 用「修改时间 + 文件大小」判断快照有没有被重写过。
  // 只缓存内存里的对象是不够的：重新跑一次抓取脚本后，dev server 不重启的话
  // 会一直拿旧数据（实测踩过），加了这一步就能立即生效。
  const stat = statSync(SNAPSHOT_PATH);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (snapshotData && snapshotStamp === stamp) return snapshotData;

  try {
    snapshotData = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
    snapshotStamp = stamp;
    return snapshotData;
  } catch {
    snapshotData = null;
    snapshotStamp = "";
    return null;
  }
}

/**
 * 从快照里按「请求中心 + 半径」筛。
 * 快照存的是全区域原始坐标，不含 distance —— 因为距离是相对起点算的，
 * 换个校门就是另一组数，所以每次现算。
 * 返回 null 表示"没有快照可用"，调用方据此决定要不要走网络。
 *
 * 同时把快照自己的产地带出来（snapshot.source，例如 "openstreetmap"）：
 * OSM 是 ODbL 协议，页面上必须标署名，但腾讯快照不需要 —— 所以前端要知道
 * 这一份数据到底是谁的，光靠 dataSource="snapshot" 分不出来。
 */
async function fetchFromSnapshot({ lng, lat, radius }) {
  const snapshot = await loadSnapshot();
  if (!snapshot?.pois?.length) return null;

  const requestCenter = { lng, lat };
  const byId = new Map();

  for (const poi of snapshot.pois) {
    const distance = Math.round(haversine({ lng: poi.lng, lat: poi.lat }, requestCenter));
    if (distance > radius) continue;
    byId.set(poi.id, { ...poi, distance });
  }

  return {
    pois: [...byId.values()].sort((a, b) => a.distance - b.distance),
    origin: snapshot.source ?? "",
  };
}

export async function getPois({ lng, lat, radius }) {
  const key = process.env.TENCENT_MAP_KEY;

  const build = (pois) => ({
    center: { lng, lat },
    radius,
    pois,
  });

  // 0. 有本地快照就永远用它，一次网络都不发
  const snapshot = await fetchFromSnapshot({ lng, lat, radius });
  if (snapshot) {
    // origin 只有快照才有：腾讯/mock 的数据不需要额外署名，前端据此决定显不显示
    return {
      dataSource: "snapshot",
      payload: { ...build(snapshot.pois), origin: snapshot.origin },
    };
  }

  if (!key) {
    return { dataSource: "mock", payload: build(await fetchFromMock({ lng, lat, radius })) };
  }

  try {
    const pois = await fetchFromTencent({ key, lng, lat, radius });
    return { dataSource: "tencent", payload: build(pois) };
  } catch (error) {
    // 上游挂了（配额用完 / 限流 / 网络）不要让整页白掉：
    // 退回示例数据保底，但把真实原因带出去，前端会明确标出「这些不是真实数据」。
    // 注意：这种降级结果**不写缓存**，否则明天配额恢复了还会一直读它。
    if (!(error instanceof PoisError)) throw error;

    const pois = await fetchFromMock({ lng, lat, radius });
    return {
      dataSource: "mock-fallback",
      notice: error.message,
      payload: build(pois),
    };
  }
}
