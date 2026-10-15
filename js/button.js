/**
 * 按钮模块
 * ------------------------------------------------------------
 * 把配置里的文案和跳转地址写到页面的按钮上。
 * 同样在顶部写明依赖，同样导出一个 init 函数。
 */

import { site } from './config.js';

export function initButton() {
  const el = document.querySelector('#enter-btn');
  if (!el) return; // 这个页面上没有这个按钮就跳过

  // 文案
  if (site.button.text) {
    el.textContent = site.button.text;
  }

  // 跳转地址（没配就给个死链接，避免跳到 undefined）
  el.setAttribute('href', site.button.href || '#');
}
