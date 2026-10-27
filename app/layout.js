import localFont from "next/font/local";
import "./globals.css";

// 原来是 next/font/google 的 Geist / Geist Mono —— 它会在 build 时去
// fonts.googleapis.com 下载字体，本机连不上就整个 build 失败。
// 现在改成自托管：字体文件就在 app/fonts/ 里，build 和运行都不再联网。
// CSS 变量名（--font-geist-sans / --font-geist-mono）没变，globals.css 不用动。
const geistSans = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata = {
  title: "我的博客",
  description: "走进软件课程作业",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* animate.css：页面里那些 animate__animated / animate__backInLeft 来自这里。
            React 19 会把带 precedence 的 <link> 自动提到 <head> 里，不用手写 head。 */}
        <link
          rel="stylesheet"
          href="https://cdn.bootcdn.net/ajax/libs/animate.css/4.1.1/animate.min.css"
          precedence="animate.css"
        />
        {children}
      </body>
    </html>
  );
}
