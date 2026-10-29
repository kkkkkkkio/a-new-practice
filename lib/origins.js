// 起点：北京航空航天大学（学院路校区）的四个校门。
//
// ⚠ 这里的经纬度是按校园中心 (116.348, 39.981) 向四周推出来的**粗估值**，
//    不是实测坐标。误差大概几十米，对「按时间筛选周边地点」这种场景够用；
//    如果要精确，拿起点 id 去查一下真实点位，改这个文件即可，别处不用动。
//    坐标系是 GCJ-02，和腾讯地图一致，不需要转换。

export const ORIGINS = [
  { id: "north", label: "北门", lng: 116.3455, lat: 39.9862 },
  { id: "west", label: "西门", lng: 116.339, lat: 39.981 },
  { id: "east3", label: "东三门", lng: 116.3555, lat: 39.9795 },
  { id: "south", label: "南门", lng: 116.3465, lat: 39.9758 },
];

export const DEFAULT_ORIGIN_ID = "north";

export function originById(id) {
  return ORIGINS.find((o) => o.id === id) ?? ORIGINS[0];
}
