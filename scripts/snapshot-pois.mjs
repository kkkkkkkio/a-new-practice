// 一次性快照：把学校周边一整片区域的 POI 抓下来，存成静态 JSON。
//
// 之后应用就再也不调腾讯的「地点搜索」了（那个接口一天只有 200 次），
// 只读这份文件 —— 零调用、不会过期、换个起点也照样能筛（后端按距离现算）。
// 地图底图仍然走 JS API，那是另一套配额（图面初始化），跟这个不冲突。
//
// 用法（在项目根目录）：
//   node --env-file=.env.local scripts/snapshot-pois.mjs
//
// 成本：20 个采样点 × 6 个分类，内圈翻 2 页、外圈只翻 1 页，最坏 156 次额度
// （个人 key 是 200 次/日，留 40 多次余量）。一次抓完，永久使用。
// 中途失败不用怕：每抓完一个采样点就把结果落盘到 .data/snapshot-progress.json，
// 重跑会跳过已完成的部分，已经花掉的额度不会白费。

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, mapTencentCategory } from "../lib/categories.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WS_URL = "https://apis.map.qq.com/ws/place/v1/search";

// 抓取范围：以校园中心为基准铺网格，每个采样点查周边 1000m。
//
// 两个约束决定了间距和网格大小：
//   ① 相邻采样点的间距必须 **小于 2000m**（= 两个 1000m 半径之和），否则两圆之间留缝。
//     下面 x / y 方向的间距都是 1400m < 2000 ✓，对角 1980m < 2000 ✓，也接上了。
//   ② 覆盖半径按**轴方向**算：max(2800, 2100) + 1000 = 3800m（正西）、3100m（正南正北）。
//
// 为什么 x / y 不对称（5 列 4 行）：
//   - 用户能换 4 个校门当起点，每个校门最远要看到自己往外 2200m；
//   - 四个门离校园中心的距离不同，西 767m、东三门 660m、北 616m、南 592m，
//     所以正西方向要覆盖到 767 + 2200 = 2967m，其他方向 2816m 就够；
//   - 实测（72 个方位逐一验算）4×4 对称网格在正西 270° 处最坏缝隙 1117m > 1000m，
//     会漏掉西边一条带 —— 所以往西多铺一列。
const CENTER = { lng: 116.348, lat: 39.981 };
const GRID_X_M = [-2800, -1400, 0, 1400, 2800];
const GRID_Y_M = [-2100, -700, 700, 2100];
const SAMPLE_RADIUS_M = 1000;
const PAGE_SIZE = 20;

// 分页深度按「离学校的远近」给：校园周边（用户真正会看的）翻 2 页，
// 外圈只为兜住覆盖、翻 1 页就够。这样最坏 6×2 + 14×1 = 26 组 × 6 分类 = 156 次，
// 不会把 200 次/日的额度一次烧光。
const INNER_X_M = 1400;
const INNER_Y_M = 700;
const INNER_PAGES = 2;
const OUTER_PAGES = 1;

function pagesFor(dx, dy) {
  const inner = Math.abs(dx) <= INNER_X_M && Math.abs(dy) <= INNER_Y_M;
  return inner ? INNER_PAGES : OUTER_PAGES;
}

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320 * Math.cos((CENTER.lat * Math.PI) / 180);

const OUT_PATH = resolve(__dirname, "../public/data/pois-snapshot.json");
const PROGRESS_PATH = resolve(__dirname, "../.data/snapshot-progress.json");

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

function buildGrid() {
  const points = [];
  for (const dy of GRID_Y_M) {
    for (const dx of GRID_X_M) {
      points.push({
        dx,
        dy,
        lat: CENTER.lat + dy / M_PER_DEG_LAT,
        lng: CENTER.lng + dx / M_PER_DEG_LNG,
      });
    }
  }
  return points;
}

function coverRadius() {
  return Math.max(Math.max(...GRID_X_M.map(Math.abs)), Math.max(...GRID_Y_M.map(Math.abs))) + SAMPLE_RADIUS_M;
}

// 和 lib/pois-service.js 一样的速率闸：腾讯是 5 次/秒/接口/key
let nextSlotAt = 0;
async function throttle() {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + 210;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function callSearch({ key, keyword, center, page }) {
  const url = new URL(WS_URL);
  url.searchParams.set("key", key);
  url.searchParams.set("keyword", keyword);
  url.searchParams.set(
    "boundary",
    `nearby(${center.lat},${center.lng},${SAMPLE_RADIUS_M},0)`,
  );
  url.searchParams.set("page_size", String(PAGE_SIZE));
  url.searchParams.set("page_index", String(page));
  url.searchParams.set("orderby", "_distance");

  await throttle();
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  if (json.status !== 0) {
    throw new Error(`status=${json.status} ${json.message || ""}`);
  }
  return Array.isArray(json.data) ? json.data : [];
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ── 断点续抓 ───────────────────────────────────────────────
// 把「网格 + 分类 + 分页参数」拼成一个指纹；参数一改，旧进度自动作废，
// 免得改了范围却读到上一次的残留。
const SIGNATURE = JSON.stringify({
  gridX: GRID_X_M,
  gridY: GRID_Y_M,
  center: CENTER,
  radius: SAMPLE_RADIUS_M,
  size: PAGE_SIZE,
  pages: [INNER_X_M, INNER_Y_M, INNER_PAGES, OUTER_PAGES],
  categories: CATEGORIES.map((c) => [c.id, c.keyword]),
});

function loadProgress() {
  try {
    const raw = JSON.parse(readFileSync(PROGRESS_PATH, "utf8"));
    if (raw?.signature !== SIGNATURE) return { done: {} };
    return { done: raw.done ?? {} };
  } catch {
    return { done: {} };
  }
}

function saveProgress(done) {
  mkdirSync(dirname(PROGRESS_PATH), { recursive: true });
  writeFileSync(PROGRESS_PATH, JSON.stringify({ signature: SIGNATURE, done }), "utf8");
}

const key = process.env.TENCENT_MAP_KEY;
if (!key) {
  console.error("没有找到 TENCENT_MAP_KEY。请用 node --env-file=.env.local 运行。");
  process.exit(1);
}

const grid = buildGrid();
const { done } = loadProgress();
let requests = 0;

const alreadyDone = Object.keys(done).length;
console.log(
  `抓取范围：以 (${CENTER.lng}, ${CENTER.lat}) 为中心，` +
    `${grid.length} 个采样点 × ${CATEGORIES.length} 个分类` +
    `（每点半径 ${SAMPLE_RADIUS_M}m，覆盖约 ${coverRadius()}m）`,
);
if (alreadyDone > 0) console.log(`检测到上次进度：已完成 ${alreadyDone}/${grid.length} 个采样点，跳过。`);
console.log("");

for (const [index, center] of grid.entries()) {
  if (done[index]) continue;

  const label = `采样点 ${index + 1}/${grid.length}`;
  const startedAt = Date.now();
  const maxPages = pagesFor(center.dx, center.dy);

  try {
    const batches = await mapWithConcurrency(CATEGORIES, 2, async (category) => {
      const out = [];
      for (let page = 1; page <= maxPages; page++) {
        const items = await callSearch({ key, keyword: category.keyword, center, page });
        requests++;
        out.push(...items.map((item) => ({ item, keywordCategory: category.id })));
        if (items.length < PAGE_SIZE) break;
      }
      return out;
    });

    // 这里只按采样点存原始结果，跨点的去重留到最后统一做
    const rows = [];
    for (const { item, keywordCategory } of batches.flat()) {
      const lng = Number(item.location?.lng);
      const lat = Number(item.location?.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      rows.push({
        id: item.id,
        name: item.title || "未命名地点",
        category: mapTencentCategory(item.category) ?? keywordCategory,
        lng,
        lat,
        address: item.address || "",
      });
    }

    done[index] = rows;
    saveProgress(done);

    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const total = Object.values(done).reduce((n, list) => n + list.length, 0);
    console.log(`  ${label} 完成：${rows.length} 条（含重复），累计 ${total} 条，请求 ${requests} 次（${secs}s）`);
  } catch (error) {
    console.error(`\n${label} 失败：${error.message}`);
    console.error("如果是「调用量已达到上限」（status=121），说明今日额度用完了，等 0 点后再跑一次");
    console.error("—— 已完成的采样点不会重抓，不会浪费额度。");
    process.exit(1);
  }
}

// ── 汇总去重 ───────────────────────────────────────────────
const byId = new Map();
for (const rows of Object.values(done)) {
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
}

// 兜底：过滤掉离校园中心过远的点（网格角落可能捞到隔壁街区的）
const MAX_KEEP_M = 3200;
const kept = [...byId.values()].filter(
  (p) => haversine({ lng: p.lng, lat: p.lat }, CENTER) <= MAX_KEEP_M,
);

kept.sort((a, b) => haversine(a, CENTER) - haversine(b, CENTER));

if (kept.length < 20) {
  console.error(`\n只抓到 ${kept.length} 条，太少了，不覆盖现有快照。检查一下 key 和额度。`);
  process.exit(1);
}

const snapshot = {
  _note:
    "腾讯位置服务的一次性快照。运行 scripts/snapshot-pois.mjs 重新生成。" +
    "只含真实字段（名称/分类/坐标/地址），不含营业时间、人均消费等编造信息。",
  center: CENTER,
  coverRadius: coverRadius(),
  capturedAt: new Date().toISOString(),
  pois: kept,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

// 成功了就把进度文件删掉：下次再跑是一次全新的抓取，而不是"无事可做"
try {
  unlinkSync(PROGRESS_PATH);
} catch {
  /* 本来就没这个文件 */
}

const stats = {};
for (const p of kept) stats[p.category] = (stats[p.category] || 0) + 1;

console.log("\n────────────");
console.log(`共 ${kept.length} 个地点 -> ${OUT_PATH}`);
console.log(`分类：${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`上游请求 ${requests} 次`);
console.log(`文件大小 ${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB`);
