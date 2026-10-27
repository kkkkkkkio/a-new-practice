// 分类的唯一真源：枚举、中文名、颜色都只在这里定义一次。
// 别在别的文件里再写一遍 "cafe" / "#xxxxxx" 这类字面量，否则以后加分类要改好几处。

export const ALL_CATEGORY = { id: "all", label: "全部", color: "#52525b" };

export const CATEGORIES = [
  { id: "restaurant", label: "餐饮", color: "#e8590c" },
  { id: "cafe", label: "咖啡", color: "#8c5a3c" },
  { id: "transit", label: "交通", color: "#1d7fd6" },
  { id: "market", label: "超市", color: "#2f9e44" },
  { id: "campus", label: "校园", color: "#726fab" }, // 跟站点主色一致
];

// 半径三档，单位米
export const RADIUS_OPTIONS = [500, 1000, 2000];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

// 查不到就退回主色，避免脏数据把 marker 画成透明
export function categoryColor(id) {
  return BY_ID.get(id)?.color ?? "#52525b";
}

export function categoryLabel(id) {
  return BY_ID.get(id)?.label ?? id;
}
