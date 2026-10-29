// 路由：/map
// Server Component 路由壳：只负责渲染下面的客户端地图组件，自己不碰 window。

import MapView from "./MapView";

export const metadata = {
  title: "map",
};

export default function MapPage() {
  return (
    // 需求 4：页面右侧要有一条垂直滚动条。
    // 做法是让 main 自己成为滚动容器（定高 + overflow-y-auto），
    // 而不是靠 body 滚 —— 这样滚动条只出现在地图页，首页不受影响。
    // 标题行和右上角那几个按钮都在 MapView 里（它们要用「路标」的状态）。
    <main className="map-scroll h-screen overflow-y-auto px-8 py-10">
      <MapView />
    </main>
  );
}
