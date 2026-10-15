/**
 * 入口
 * ------------------------------------------------------------
 * 浏览器只加载这一个文件 —— 就是 index.html 底部那一行：
 *   <script type="module" src="js/main.js"></script>
 *
 * 它干的事只有两件：
 *   1. 把各个模块 import 进来（依赖关系白纸黑字写在这儿）
 *   2. 按顺序调用它们的 init 函数
 *
 * script 标签的顺序坑，就是在这里被治好的：
 * 每个模块要什么，它自己顶上写着；浏览器读到 import 就去取，
 * 取完再往下跑。顺序由代码声明，不再藏在 HTML 的排列里。
 *
 * 以后加新功能：
 *   1. 在 js/ 下写一个模块，export 出 initXxx()
 *   2. 回到这里 import 它
 *   3. 调用
 */

import { initTitle } from './title.js';
import { initButton } from './button.js';

initTitle();
initButton();
