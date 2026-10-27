// 一次性脚本：生成 public/mock/pois.json
// 直接 node scripts/gen-mock.mjs 跑，不参与运行时，app 里不引用它。
//
// 为什么用脚本而不是手写 48 条坐标：
// distance 字段必须和 lng/lat 严格对应，手算 48 个球面距离必错，错了半径筛选就是错的。

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CENTER = { lng: 116.348, lat: 39.981 };
const OUT_RADIUS = 2000;
const COUNT = 48;

// 分类顺序固定，后面按 i % 5 轮流取，保证每类数量接近
const CATEGORIES = [
  { id: "restaurant", label: "餐饮" },
  { id: "cafe", label: "咖啡" },
  { id: "transit", label: "交通" },
  { id: "market", label: "超市" },
  { id: "campus", label: "校园" },
];

// 线性同余伪随机：不用 Math.random，保证每次生成结果完全一致（可复现）
let seed = 20261027;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

// 三档距离，让 500 / 1000 / 2000 三个半径都有点可筛
const BANDS = [
  [120, 460], // 500m 档内
  [520, 940], // 1000m 档内
  [1000, 1850], // 2000m 档内
];

const M_PER_DEG_LAT = 110540; // 纬度 1 度约 110.54km
const M_PER_DEG_LNG = 111320 * Math.cos((CENTER.lat * Math.PI) / 180); // 经度 1 度随纬度收缩

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

const perCategory = new Map(CATEGORIES.map((c) => [c.id, 0]));
const pois = [];

for (let i = 0; i < COUNT; i++) {
  const category = CATEGORIES[i % CATEGORIES.length];
  const [minR, maxR] = BANDS[Math.floor(i / CATEGORIES.length) % BANDS.length];

  // 先在「米」这个尺度上撒点，再换算成经纬度
  const r = minR + rnd() * (maxR - minR);
  const angle = rnd() * Math.PI * 2;
  const dx = Math.cos(angle) * r;
  const dy = Math.sin(angle) * r;

  // 保留 6 位小数（约 0.1m 精度），然后**用四舍五入后的坐标**反算距离，
  // 否则 distance 和 lng/lat 会有零点几米的偏差，筛选边界上会对不上
  const lat = Number((CENTER.lat + dy / M_PER_DEG_LAT).toFixed(6));
  const lng = Number((CENTER.lng + dx / M_PER_DEG_LNG).toFixed(6));
  const distance = Math.round(haversine({ lat, lng }, CENTER));

  const n = (perCategory.get(category.id) ?? 0) + 1;
  perCategory.set(category.id, n);

  pois.push({
    id: `p${String(i + 1).padStart(3, "0")}`,
    name: `示例·${category.label} ${String(n).padStart(2, "0")}`,
    category: category.id,
    lng,
    lat,
    address: `示例地址 ${i + 1} 号`,
    distance,
  });
}

// 自检：所有点必须在 2000m 内，且 distance 与坐标一致
const bad = pois.filter((p) => p.distance > OUT_RADIUS);
if (bad.length) {
  throw new Error(`有 ${bad.length} 个点超出 ${OUT_RADIUS}m：${bad.map((p) => p.id).join(",")}`);
}

const out = {
  _note: "示例数据，非真实 POI，仅用于渲染联调",
  center: CENTER,
  radius: OUT_RADIUS,
  pois,
};

const target = resolve(__dirname, "../public/mock/pois.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 2) + "\n", "utf8");

const stats = [...perCategory.entries()].map(([k, v]) => `${k}=${v}`).join(" ");
const within = (r) => pois.filter((p) => p.distance <= r).length;
console.log(`已生成 ${pois.length} 个点 -> ${target}`);
console.log(`分类统计: ${stats}`);
console.log(`距离分布: <=500m ${within(500)} 个, <=1000m ${within(1000)} 个, <=2000m ${within(2000)} 个`);
console.log(`最远 ${Math.max(...pois.map((p) => p.distance))}m，最近 ${Math.min(...pois.map((p) => p.distance))}m`);
