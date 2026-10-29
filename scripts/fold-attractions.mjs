// 把景区里的小景点并进父景区。
//
// 为什么需要这一步：15km 半径下最刺眼的已经不是点太多，而是「颐和园」这块
// 蓝色范围里还撒着铜牛、文昌阁、谐趣园、德和园、眺远斋……十几个独立标记，
// 远看就是一团麻；圆明园遗址公园更夸张，里面 80 个子景点。
// 这些子景点在 OSM 里确实是独立实体，但在「我半小时能去哪」这个场景里没有
// 独立存在的意义 —— 人是一次进园逛一片，不是一个亭子一个亭子打卡。
//
// 规则（宁可少折不折错）：
//   1. 只折 attraction → attraction。餐饮 / 商超 / 车站绝不能折：
//      它们是真实独立的个体，折进商场就再也查不到了。
//   2. 父景点必须有真实多边形（area），且子点的坐标真的落在多边形内（射线法）。
//   3. 多个父景点都包含它时，取**最紧的那个**（外接盒面积最小），
//      这样「某亭子在颐和园里」不会因为植物园的大轮廓也盖住了它而认错爹。
//   4. 子景点自己的外接盒比父景点还大 → 不是「园内小景点」，不折。
//   5. 中间层也算：A 在 B 里、B 在 C 里，A 直接并进 C，不留在半路的 B 上。
//
// 被折掉的子景点不是消失，名字会进父景点的 `contains` 数组，弹窗里照样看得到。

const M_PER_DEG_LAT = 110540;

function bboxOf(ring) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const mPerDegLng = 111320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  return {
    minLat,
    maxLat,
    minLng,
    maxLng,
    // 用外接盒面积比大小，不追求真实面积 —— 只用来「谁更紧」排序
    m2: (maxLat - minLat) * M_PER_DEG_LAT * ((maxLng - minLng) * mPerDegLng),
  };
}

/**
 * 射线法：点是否在环内。
 *
 * ring 是 [[lat, lng], ...]（快照里的格式，注意不是 [lng, lat]）。
 * 标准的 even-odd 判定：往东发一条射线，数它穿过多少条边，奇数就在里面。
 * 凹多边形也照样对 —— 颐和园这种带湖岸曲折的轮廓如果换成"外接盒判定"，
 * 会把旁边的路也算进去。
 */
function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    const crosses = latI > lat !== latJ > lat;
    if (crosses && lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI) {
      inside = !inside;
    }
  }
  return inside;
}

function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * @param {Array} pois 快照里的原始点（GCJ-02，景点带 area: [[lat,lng],...]）
 * @returns {{ pois: Array, folded: Array<{parent: string, children: number}>, removedCount: number }}
 */
export function foldAttractions(pois) {
  const byId = new Map(pois.map((p) => [p.id, p]));

  // 候选父景点：景点 + 有真实多边形
  const parents = [];
  for (const p of pois) {
    if (p.category !== "attraction") continue;
    if (!Array.isArray(p.area) || p.area.length < 3) continue;
    parents.push({ poi: p, box: bboxOf(p.area) });
  }

  // 每个景点找它最紧的那个父景点（不折自己）
  const parentOf = new Map();
  for (const child of pois) {
    if (child.category !== "attraction") continue;
    let best = null;
    for (const cand of parents) {
      if (cand.poi.id === child.id) continue;
      const { box } = cand;
      // 外接盒粗筛：连盒子都不在，不用跑射线法（1028 × 680 全跑太浪费）
      if (child.lat < box.minLat || child.lat > box.maxLat) continue;
      if (child.lng < box.minLng || child.lng > box.maxLng) continue;
      // 子比父还大 → 这俩是包含关系的可能性不大，宁可不动
      if (child.area && bboxOf(child.area).m2 > box.m2) continue;
      if (!pointInRing(child.lat, child.lng, cand.poi.area)) continue;
      if (!best || box.m2 < best.box.m2) best = cand;
    }
    if (best) parentOf.set(child.id, best.poi.id);
  }

  // 顺着包含链爬到最外层：中间层（谐趣园）自己不占标记，名字一起并上去
  const rootOf = (id) => {
    let cur = id;
    const seen = new Set([id]);
    while (parentOf.has(cur)) {
      const next = parentOf.get(cur);
      if (seen.has(next)) break; // 数据里万一是环，停下来别死循环
      seen.add(next);
      cur = next;
    }
    return cur;
  };

  const namesByRoot = new Map();
  const removed = new Set();
  for (const childId of parentOf.keys()) {
    const root = rootOf(childId);
    // 只有包含链绕回自己（坏数据成环）时才放弃；正常情况 root 就等于它的父景点
    if (root === childId) continue;
    const child = byId.get(childId);
    if (!child) continue;
    removed.add(childId);
    // 同名子点 = 同一个地方被映射了两遍（一个面 + 一个点），
    // 写进 contains 就成了「颐和园包含颐和园」，所以只删不记。
    if (child.name === byId.get(root)?.name) continue;
    if (!namesByRoot.has(root)) namesByRoot.set(root, []);
    namesByRoot.get(root).push(child);
  }

  const folded = [];
  for (const [rootId, children] of namesByRoot) {
    const root = byId.get(rootId);
    if (!root) continue;
    // 按离父景点中心的距离排：先列出更靠近的那个，读起来像一条逛园路线
    children.sort((a, b) => haversineM(a, root) - haversineM(b, root));
    const names = [];
    for (const c of children) if (!names.includes(c.name)) names.push(c.name);
    root.contains = names;
    folded.push({ parent: root.name, children: names.length });
  }

  for (const id of removed) byId.delete(id);

  // ── 同名「点」冗余去重 ───────────────────────────────────────
  //
  // 折叠只认「点在面里」。可同一个景点常被映射成「一个面 + 一个点在门口」，
  // 门口那个点常常正好压边界、甚至出界十几米 —— 折叠接不住，地图上就还是
  // 一个蓝色范围旁边飘着一个同名标记（颐和园就是这样：1 个面 + 1 个裸点）。
  // 判据：同名 + 点落在那块面的外接盒（放宽 150m）里 → 同一个地方，删点。
  const areaByName = new Map();
  for (const p of byId.values()) {
    if (p.category !== "attraction" || !Array.isArray(p.area) || p.area.length < 3) continue;
    if (!areaByName.has(p.name)) areaByName.set(p.name, []);
    areaByName.get(p.name).push(bboxOf(p.area));
  }
  const padLat = 150 / M_PER_DEG_LAT;
  const dupes = [];
  for (const p of byId.values()) {
    if (p.category !== "attraction" || Array.isArray(p.area)) continue;
    const boxes = areaByName.get(p.name);
    if (!boxes) continue;
    const padLng = 150 / (111320 * Math.cos((p.lat * Math.PI) / 180));
    const same = boxes.some(
      (b) =>
        p.lat >= b.minLat - padLat &&
        p.lat <= b.maxLat + padLat &&
        p.lng >= b.minLng - padLng &&
        p.lng <= b.maxLng + padLng,
    );
    if (same) dupes.push(p.id);
  }
  for (const id of dupes) byId.delete(id);

  folded.sort((a, b) => b.children - a.children);

  return { pois: [...byId.values()], folded, removedCount: removed.size, dedupedCount: dupes.length };
}
