// 路由：/home
// 文件在 app/home/page.js —— App Router 里，目录名就是 URL 路径。

import Link from "next/link";

export const metadata = {
  title: "home",
};

export default function HomePage() {
  return (
    <main className="page">
      {/* 和首页 / 的那套完全一样：灰框 .btn-box 包住 .btn，一起从左飞入。
          只改了 Link 的目标：/map（对应 app/map/page.js） */}
      <div className="btn-box animate__animated animate__backInLeft">
        <Link href="/map" className="btn animate__animated animate__backInLeft">
          地图
        </Link>
      </div>
    </main>
  );
}
