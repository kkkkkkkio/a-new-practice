// 数据来源编排：缓存 → 腾讯周边搜索 → （没 key 或上游失败就）降级读 mock。
// 只被 Route Handler 调用，不参与任何前端代码。

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CATEGORIES, mapTencentCategory } from "./categories";

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
 * 采样中心：半径 <= 1000m 时只查一次；超过时在四周各补一个中心，
 * 否则 2000m 的圈里只有中间一小块有数据。
 */
function buildCenters(lng, lat, radius) {
  if (radius <= UPSTREAM_MAX_RADIUS) return [{ lng, lat }];

  const offsetM = Math.min(UPSTREAM_MAX_RADIUS, radius - UPSTREAM_MAX_RADIUS / 2);
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

async function callSearch({ key, keyword, center, radius, page }) {
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

export async function getPois({ lng, lat, radius }) {
  const key = process.env.TENCENT_MAP_KEY;
  const dataSource = key ? "tencent" : "mock";

  const pois = key
    ? await fetchFromTencent({ key, lng, lat, radius })
    : await fetchFromMock({ lng, lat, radius });

  // 返回体形状必须和 mock 完全一致，前端才能无感切换
  return {
    dataSource,
    payload: {
      center: { lng, lat },
      radius,
      pois,
    },
  };
}
