import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
