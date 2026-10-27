// 路由：/home
// 文件在 app/home/page.js —— App Router 里，目录名就是 URL 路径。
//
// 已回退：原来这里的音频读取条（AudioBar）和「转文字」按钮都移除了，
// 现在是个空白页，功能留给你重新做。

export const metadata = {
  title: "home",
};

export default function HomePage() {
  return (
    <main className="page">
      {/* 空白页面 —— 功能写在这里 */}
    </main>
  );
}
