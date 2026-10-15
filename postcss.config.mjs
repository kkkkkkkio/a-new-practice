/** PostCSS 配置 —— 让 Next 用 PostCSS 编译 Tailwind。
 *
 *  app/globals.css 顶上那句 @import "tailwindcss" 就是靠它编译的。
 *  有了这个文件之后，next.config.mjs 里那条 @tailwindcss/turbopack 自定义 loader 规则就不需要了。
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
