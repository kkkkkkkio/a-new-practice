// 「在 N 时间内用某方式能到多远」的换算，前后端共用：
//   前端用它把每个点的距离换算成「要走多久」，并按选定时间过滤；
//   后端用它决定这次该抓多大范围（时间越长、方式越快，范围越大）。

export const TRAVEL_MODES = [
  { id: "walk", label: "步行", speedKmh: 4.8 },
  { id: "bike", label: "骑行", speedKmh: 15 },
];

export const TIME_OPTIONS = [
  { id: "10m", label: "10 分钟", minutes: 10 },
  { id: "30m", label: "半小时", minutes: 30 },
  { id: "60m", label: "一小时", minutes: 60 },
];

// 一次查询最多抓多远。**必须和 public/data/pois-snapshot.json 的 coverRadius 对齐**：
// 快照按 15000m 抓，请求再大也只会返回这么多点，前端却以为"能看到更远"，
// 于是切换时间时地图一动不动（原来上限 2200 时，步行半小时/一小时、骑行全部被夹成
// 同一个半径，那就是"点了没反应"的根因；之后按 3200 → 6000 → 15000 逐级对齐）。
// 15000 正好是「骑行一小时」的可达距离，所以六个组合的数据现在都能覆盖到。
// 腾讯路径在超过 2200m 时采样覆盖不全（见 lib/pois-service.js 的 buildCenters），
// 但那条路配额为 0 走不通，实际数据全部来自快照，不受影响。
export const MAX_QUERY_RADIUS = 15000;
export const MIN_QUERY_RADIUS = 600;

export function modeById(id) {
  return TRAVEL_MODES.find((m) => m.id === id) ?? TRAVEL_MODES[0];
}

export function timeById(id) {
  return TIME_OPTIONS.find((t) => t.id === id) ?? TIME_OPTIONS[0];
}

// 理论上能到多远（米）：速度 × 时间，按直线算（路网绕行会让实际更短）
export function reachRadius(modeId, timeId) {
  const { speedKmh } = modeById(modeId);
  const { minutes } = timeById(timeId);
  return Math.round((speedKmh * 1000) / 60 * minutes);
}

// 真正拿去请求接口的半径：夹在 [MIN, MAX] 之间
export function queryRadius(modeId, timeId) {
  const reach = reachRadius(modeId, timeId);
  return Math.min(Math.max(reach, MIN_QUERY_RADIUS), MAX_QUERY_RADIUS);
}

// 反算：给定直线距离，用某种方式要花几分钟（最少 1 分钟，不显示 0）
export function travelMinutes(distanceM, modeId) {
  const { speedKmh } = modeById(modeId);
  const perMinute = (speedKmh * 1000) / 60;
  return Math.max(1, Math.round(Number(distanceM) / perMinute));
}

// 分钟数转成人话：75 → 「1 小时 15 分钟」
export function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

// 距离格式化：820 → 「820m」，1846 → 「1.8km」
export function formatDistance(meters) {
  const n = Number(meters);
  if (!Number.isFinite(n)) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}km` : `${Math.round(n)}m`;
}

/**
 * 两点直线距离（米），haversine。
 *
 * 前端也要算一次：从收藏夹点某一项定位时，弹窗里要显示「距离多远」，
 * 但收藏表里只存了坐标（服务端返回的 distance 是相对当时那次请求的圆心算的，
 * 换个起点就不对了）。公式和服务端 lib/pois-service.js 里那份保持一致。
 */
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
