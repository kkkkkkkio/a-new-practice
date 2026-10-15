# AGENTS.md

> 给 AI 编码助手（WorkBuddy / Codex / Claude Code 等）看的项目说明。
> 在改动这个仓库之前，先读完本文件。
>
> 本文件对应的仓库目录：`C:\Users\ASUS\Desktop\new folder`

## 项目概况

`a-new-practice` —— 「走进软件」课程作业项目（学习用途，非生产项目）。

- 形态：纯静态网页（HTML + CSS + ES 模块 JS），由 **Vite 8** 提供开发服务器与打包
- **没有运行时依赖**：`vite` 只装在 `devDependencies`，最终产物是纯静态文件
- 前端入口：`js/main.js`，由 `index.html` 底部的 `<script type="module">` 加载
- Vite 的构建入口就是根目录的 `index.html`（不是 `js/main.js`）
- 语言：JavaScript，**统一使用 ES 模块语法**（`import` / `export`）
- 包管理器：npm
- 远程仓库：`git@github.com:kkkkkkkio/a-new-practice.git`（SSH）

## 环境

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows 11 |
| Node.js | Vite 8 要求 `^20.19.0 \|\| >=22.12.0`；开发者本机为 24.19.0 |
| npm | 10.x |
| Vite | 8.3.4（`devDependencies`） |
| 默认分支 | `main` |
| Shell | PowerShell、Git Bash |

## 目录结构

```
.
├── index.html          # 页面（也是 Vite 构建入口；底部只引一行 js/main.js）
├── styles.css          # 样式
├── js/
│   ├── main.js         # 前端入口：import 各模块并依次调用
│   ├── config.js       # 站点配置（标题、按钮文案与跳转地址）
│   ├── title.js        # 标题模块，导出 initTitle()
│   └── button.js       # 按钮模块，导出 initButton()
├── dist/               # vite build 的产物，已忽略，不要手改、不要提交
├── package.json
├── package-lock.json   # 要提交（锁依赖版本）
├── .gitignore
├── README.md
└── AGENTS.md           # 本文件
```

`node_modules/`、`dist/` 不入库。

> 历史提醒：根目录**曾**有一个空的 `main.js`（早期 Node 入口，与前端入口 `js/main.js` 是两个不同文件），现已删除。
> 当前项目**只有** `js/main.js` 一个入口，看到文档里提「根目录 main.js」一律按已删除处理。

## 常用命令

```bash
# 开发（主用）：Vite 开发服务器，改完即时热更新
npm run dev            # 默认 http://localhost:5173/

# 打包 / 本地预览产物
npm run build          # 输出到 dist/
npm run preview        # 起一个服务预览 dist/

# 备用（不装依赖也能看页面）
python -m http.server 3000    # 然后浏览器访问 http://localhost:3000
```

两个坑：

1. **ES 模块必须走 HTTP。** 直接双击 `index.html`（`file://`）会被浏览器 CORS 拦掉，页面会白屏或报 `import` 相关错误。
2. **没有 `npm start`。** 早期 `package.json` 里的 `scripts.start = "node main.js"` 已随根目录 `main.js` 一起删除，别再用。

## 分工边界（重要）

**AI 助手只负责「结构」，不负责「主要代码」。**

- **AI 负责**：目录结构、模块拆分与文件组织、构建与配置文件（`package.json`、`vite.config.js` 等）、迁移与重构、排查环境与工具链问题。
- **用户负责**：页面与业务代码的实际编写 —— HTML 里的内容、CSS 样式、JS 模块内部的具体逻辑。
- **需要用户自己写的地方，AI 只提供思路、接口约定和示例片段**，不要直接写成完整成品。
- 除非用户明确说「帮我写这段」，否则不要代替用户编写业务代码。

> 原因：这是学习者的项目，**写代码本身就是目的**。AI 把代码写好，用户就失去了练习的机会。

## 代码约定

- 缩进 2 空格；语句结尾带分号。
- 命名：变量 / 函数用 `小驼峰`，类名用 `大驼峰`，常量用 `全大写_下划线`。
- 不做过度注释，只在「为什么这么写」不直观时加一行。
- 每次提交保持仓库可运行，不提交跑不起来的中间状态。
- 提交信息用 `类型: 简短描述`，例如 `feat: 添加卡片动画`、`fix: 修复按钮链接为空`。

### 模块化写法（重要）

**一律采用 ES 标准模块化编写代码** —— 不用 `require` / `module.exports`，不用全局变量传东西。

- 每个功能写成独立模块放在 `js/` 下，**导出一个 `initXxx()` 函数**；文件加载时不执行任何逻辑，等入口调用才跑。
- 模块要用到什么，**必须写在文件顶部的 `import` 里** —— 不靠 `<script>` 标签的先后顺序，不靠全局变量。
- 所有模块由 `js/main.js` 统一 `import` 并调用；HTML 里**只允许有一行** `<script type="module" src="js/main.js">`。
- 新增模块的步骤：`js/` 下建文件 → `export function initXxx()` → 在 `js/main.js` 里 `import` 并调用。
- 上了 Vite 之后模块写法**不用改**：相对路径 `import './config.js'` 依然有效，Vite 负责解析与打包。

## 给 AI 助手的工作约定

**这是一个学习者的项目，不是交付型项目。** 因此：

1. **讲思路优先于给成品。** 遇到问题时先说明「问题出在哪、为什么」，再给代码；不要一上来甩一大段完整实现。
2. **改动先声明再动手。** 说明要改哪个文件、改成什么样子，得到确认后再落盘。
3. **不要擅自新增依赖，也不要擅自修改 `package.json`、`.gitignore` 等配置文件。** 需要时必须先问，并把「加什么、为什么」讲清楚。
4. **一次只改一处。** 增量修订优于整段重写；给修改建议时用「整行替换」的形式，方便逐字对照。
5. **不确定的结论先跑再说。** 涉及「代码是否正确」「输出是否符合预期」时，先实际执行验证，不要凭模板或经验直接下判断。
6. 回答用简体中文。
7. 注意模块化。
