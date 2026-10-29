// 分类的唯一真源：前端（筛选条、地图配色、弹窗）和服务端（腾讯分类映射）都从这里取。
//
// 2026-10-28 按《地图界面需求》调整：
//   - 删掉 campus（需求要求「去掉学校相关的标志和数据」）
//   - 新增 attraction（景点，需求第 1 条）
//   - 新增 mall（商场，需求第 3 条）
//   - market 原来把「商场 / 购物」也算进来，现在这些词归 mall，market 只管超市便利店

export const ALL_CATEGORY = { id: "all", label: "全部", color: "#52525b" };

export const CATEGORIES = [
  {
    id: "restaurant",
    label: "餐饮",
    color: "#e8590c",
    keyword: "美食", // 调腾讯周边搜索时用的 keyword
    match: ["美食", "餐厅", "餐饮", "小吃", "快餐", "火锅", "烧烤", "面馆"],
  },
  {
    id: "cafe",
    label: "咖啡",
    color: "#8c5a3c",
    keyword: "咖啡",
    match: ["咖啡"],
  },
  {
    id: "attraction",
    label: "景点",
    color: "#0b7285",
    keyword: "景点",
    match: ["景点", "风景", "公园", "博物馆", "展览馆", "美术馆", "纪念馆", "名胜", "旅游"],
  },
  {
    id: "mall",
    label: "商场",
    // 原来是玫红 #c2255c，和餐饮的橙、商超的绿放在一起「红橙」两个暖色容易糊；
    // 改成紫（2026-10-29 用户要求），和起点按钮那个灰紫 #726fab 也分得开
    color: "#7c3aed",
    keyword: "购物中心",
    match: ["购物中心", "商场", "百货", "商业街", "购物广场"],
  },
  {
    id: "market",
    label: "超市",
    color: "#2f9e44",
    keyword: "超市",
    match: ["超市", "便利店", "市场"],
  },
  {
    id: "transit",
    label: "交通",
    color: "#1d7fd6",
    keyword: "公交站",
    match: ["公交", "地铁", "车站", "交通", "站台"],
  },
];

/**
 * 交通内部的两个子类（2026-10-29 第二轮需求 3：「交通类别只保留地铁站和公交站」）。
 *
 * 为什么不做成两个新分类：`favorite` 表的 category 是按 CATEGORIES 的 id 校验的，
 * 加两个新 id 会让「已经收藏的交通点」在枚举里对不上（需求文档也把这条例成待定）。
 * 所以 category 仍然是 transit，细分放在 poi.kind 里（subway / bus），
 * 筛选条上则按子类拆成两个胶囊 —— 界面上是两个选项，数据上仍是一类，互不影响。
 */
export const TRANSIT_KINDS = [
  { id: "subway", label: "地铁", color: "#1b64c8" },
  { id: "bus", label: "公交", color: "#4aa8dd" },
];

// 筛选条用的选项：全部 + 5 个分类（交通除外）+ 地铁 / 公交两个交通子类
export const FILTER_OPTIONS = [
  ALL_CATEGORY,
  ...CATEGORIES.filter((c) => c.id !== "transit"),
  ...TRANSIT_KINDS.map((k) => ({ id: k.id, label: k.label, color: k.color })),
];

/**
 * 真正可以「多个同时选中」的那 7 个类型 id（不含「全部」和「不显示」）。
 *
 * 2026-10-29：筛选条从单选改成多选 —— 点一个加一个，再点同一个就取消该类型。
 * 「全部」= 这 7 个全选，「不显示」= 一个都不选（见 FilterBar 的 selected 判定）。
 */
export const FILTER_TYPE_IDS = CATEGORIES.filter((c) => c.id !== "transit")
  .map((c) => c.id)
  .concat(TRANSIT_KINDS.map((k) => k.id));

// 曾经有过「半径 500/1000/2000」三档切换，现在半径由「时间 + 出行方式」算出来，
// 这三档只在内部兜底（比如没传参时）还会用到，前端筛选条已经不再展示它们。
export const RADIUS_OPTIONS = [500, 1000, 2000];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function categoryColor(id) {
  return BY_ID.get(id)?.color ?? "#52525b";
}

export function categoryLabel(id) {
  return BY_ID.get(id)?.label ?? id;
}

// ── 交通子类 ─────────────────────────────────────────────────
const KIND_BY_ID = new Map(TRANSIT_KINDS.map((k) => [k.id, k]));

export function transitKindLabel(kind) {
  return KIND_BY_ID.get(kind)?.label ?? "交通";
}

// 地图上点的颜色。交通按子类分色（地铁深蓝、公交浅蓝），
// 其它分类照旧 —— 这样一眼能分出「地铁站」和「公交站」。
export function poiColor(poi) {
  if (poi?.category === "transit") {
    return KIND_BY_ID.get(poi.kind)?.color ?? categoryColor("transit");
  }
  return categoryColor(poi?.category);
}

// 筛选条选中值 → 这个点要不要显示。
// 交通的子类不是独立 category，所以这里不能只比 category。
export function matchesFilter(poi, filterId) {
  if (filterId === "all") return true;
  if (filterId === "subway" || filterId === "bus") {
    return poi.category === "transit" && poi.kind === filterId;
  }
  return poi.category === filterId;
}

// 腾讯返回的 category 是中文层级串（例如「美食:咖啡厅」「交通设施服务:公交车站」）。
// 顺序很重要，先匹配的赢：
//   - 咖啡必须排在餐饮前面，因为「美食:咖啡厅」两边都能匹配上
//   - 商场必须排在餐饮前面，因为「购物中心」里也含「中心」，避免被别的规则抢走
//   - 超市排在商场后面：mall 的 match 里没有「超市」，所以「购物:超市」会落到 market
const MATCH_ORDER = ["cafe", "attraction", "transit", "mall", "market", "restaurant"];

export function mapTencentCategory(tencentCategory) {
  const text = String(tencentCategory ?? "");
  if (!text) return null;
  for (const id of MATCH_ORDER) {
    const category = BY_ID.get(id);
    if (category.match.some((word) => text.includes(word))) return id;
  }
  return null;
}
