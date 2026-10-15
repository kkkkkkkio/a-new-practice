// 路由：/translate
// 从 home 页的「转文字」按钮跳过来。目前是空白页，内容留给你写。

import Link from "next/link";

export const metadata = {
  title: "translate",
};

export default function TranslatePage() {
  return (
    <main className="page">
      <h1 className="page-title">translate</h1>
      <p className="page-sub">转文字的结果之后会显示在这里。</p>

      <Link href="/home" className="btn-translate">
        返回
      </Link>
    </main>
  );
}
