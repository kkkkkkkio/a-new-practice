// 路由：/map
// Server Component 路由壳：只负责渲染下面的客户端地图组件，自己不碰 window。

import Link from "next/link";
import MapView from "./MapView";

export const metadata = {
  title: "map",
};

export default function MapPage() {
  return (
    <main className="min-h-screen px-8 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-[#726fab]">地图</h1>
        <Link href="/" className="text-sm text-zinc-500 hover:text-[#726fab]">
          返回首页
        </Link>
      </div>

      <MapView />
    </main>
  );
}
