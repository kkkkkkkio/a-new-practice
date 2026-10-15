import Link from "next/link";

export default function Home() {
  return (
    <main className="page">
      {/* 标题：从左到右 浅蓝 → 浅紫 的渐变色，样式在 globals.css 的 .page-title */}
      <h1 className="page-title animate__animated animate__backInLeft">我的博客</h1>

      {/* 灰色圆角框框住按钮，整个框从左飞入 */}
      <div className="btn-box animate__animated animate__backInLeft">
        {/* 用 next/link 跳到 /home（对应 app/home/page.js）。
            换成 <Link> 后 URL 会带上 /home，浏览器前进/后退也能用了。 */}
        <Link href="/home" className="btn animate__animated animate__backInLeft">
          进入
        </Link>
      </div>

      {/* 右下角的装饰图。纯装饰、没有内容含义，aria-hidden 让读屏软件跳过 */}
      <div className="corner-img" aria-hidden="true" />
    </main>
  );
}
