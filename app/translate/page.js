// 路由：/translate
// 从 home 页的「转文字」按钮跳过来。
//
// 这里**没有** "use client"：它继续当服务端组件，好保留下面的 metadata。
// 交互部分（解码音频、请求后端、显示结果）在 recognizer.js 里。

import Link from "next/link";
import Recognizer from "./recognizer";

export const metadata = {
  title: "translate",
};

export default function TranslatePage() {
  return (
    <main className="page">
      <h1 className="page-title">translate</h1>

      {/* 音频识别：把 home 页选好的音频转成中文文字 */}
      <Recognizer />

      <Link href="/home" className="btn-translate">
        返回
      </Link>
    </main>
  );
}
