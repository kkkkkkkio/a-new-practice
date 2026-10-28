// 分类的唯一真源：前端（筛选条、地图配色）和服务端（腾讯分类映射）都从这里取。
// 以前 app/map/categories.js 有一份，现在合并到这里，只保留一处。

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
    id: "transit",
    label: "交通",
    color: "#1d7fd6",
    keyword: "公交站",
    match: ["公交", "地铁", "车站", "交通", "站台"],
  },
  {
    id: "market",
    label: "超市",
    color: "#2f9e44",
    keyword: "超市",
    match: ["超市", "便利店", "商场", "购物", "市场"],
  },
  {
    id: "campus",
    label: "校园",
    color: "#726fab",
    keyword: "大学",
    match: ["大学", "学院", "学校", "教育"],
  },
];

// 半径三档，单位米
export const RADIUS_OPTIONS = [500, 1000, 2000];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function categoryColor(id) {
  return BY_ID.get(id)?.color ?? "#52525b";
}

export function categoryLabel(id) {
  return BY_ID.get(id)?.label ?? id;
}

// 腾讯返回的 category 是中文层级串（例如「美食:咖啡厅」「交通设施服务:公交车站」）。
// 顺序很重要：咖啡必须排在餐饮前面，因为「美食:咖啡厅」两边都能匹配上。
const MATCH_ORDER = ["cafe", "transit", "market", "campus", "restaurant"];

export function mapTencentCategory(tencentCategory) {
  const text = String(tencentCategory ?? "");
  if (!text) return null;
  for (const id of MATCH_ORDER) {
    const category = BY_ID.get(id);
    if (category.match.some((word) => text.includes(word))) return id;
  }
  return null;
}
