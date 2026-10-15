// 路由：/home
// 文件在 app/home/page.js —— App Router 里，目录名就是 URL 路径。
//
// 注意：这个文件**没有** "use client"，它是服务端组件。
// 需要交互的部分（加号、选文件）被拆到了同目录的 audio-bar.js 里 ——
// 因为客户端组件不能导出 metadata，拆开后这里还能继续声明 title。

import Link from "next/link";
import AudioBar from "./audio-bar";

export const metadata = {
  title: "home",
};

export default function HomePage() {
  return (
    <main className="page">
      {/* 上端：读取音频（MP3）→ ＋，整体罩在白色圆角框里 */}
      <AudioBar />

      {/* 转文字按钮：黑体 + 黑色，点了去 /translate */}
      <Link href="/translate" className="btn-translate">
        转文字
      </Link>
    </main>
  );
}
