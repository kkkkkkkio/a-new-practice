/**
 * 标题模块
 * ------------------------------------------------------------
 * 负责两处标题：浏览器标签上的、页面上那个大标题。
 *
 * 改造要点（对比传统写法）：
 *   以前是一段代码写在文件顶层，浏览器加载到这个文件就立刻执行。
 *   现在把它包进一个函数、加上 export，
 *   文件加载时什么都不做，等 main.js 调用 initTitle() 才跑。
 */

// 顶上这行 import 就是"明依赖"：
// 这个文件要用 config.js 里的 site，必须自己写明。没有这行，下面的 site 拿不到。
import { site } from './config.js';

export function initTitle() {
  // 先找页面上有没有大标题 —— 没有的话，说明当前不是首页（比如 transmissions.html）
  const el = document.querySelector('#page-title');
  if (!el) return; // 不动标题，让它保持 HTML 里自己的 <title>

  document.title = site.title;
  el.textContent = site.title;
}
