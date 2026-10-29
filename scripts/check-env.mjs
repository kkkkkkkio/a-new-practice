// 环境变量防呆检查 —— 专治「服务端 key 被复用成浏览器 key」。
//
// 背景（实测踩过）：
//   NEXT_PUBLIC_ 前缀的变量会被 Next 打进前端产物，这是设计如此、无法避免。
//   所以真正危险的不是「用了 NEXT_PUBLIC_」，而是**两个变量填了同一个值**——
//   那样服务端那把（能直接调 WebService、按 IP 授权、没有域名白名单）的 key
//   就跟着 JS 一起下发给了任何访客，抓包即得。
//   而且按变量名 grep 产物是查不出来的：产物里只有 key 的值，没有变量名。
//
// 这个脚本：
//   - 两个变量都存在且值相同 -> 大声警告（不退出非 0，避免卡住本地开发）
//   - 只出现其中一个     -> 提示缺的那个会有什么后果
//   - 都不会打印 key 的值，只打印长度，防止日志/终端被截图带走
//
// 用法：
//   node scripts/check-env.mjs     # package.json 里挂了 prebuild，npm run build 会自动跑
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVER_KEY = "TENCENT_MAP_KEY";
const BROWSER_KEY = "NEXT_PUBLIC_TMAP_KEY";
const PROXY_HOST = "NEXT_PUBLIC_TMAP_PROXY_HOST";

// 只做最简单的 KEY=VALUE 解析：够用，不引依赖。
// 注意 Next 的优先级是 process.env > .env.local，这里保持一致。
function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fromFiles = {
  ...parseEnvFile(resolve(process.cwd(), ".env")),
  ...parseEnvFile(resolve(process.cwd(), ".env.local")),
};

function read(name) {
  const value = process.env[name] ?? fromFiles[name] ?? "";
  return typeof value === "string" ? value.trim() : "";
}

// 只露长度，绝不露内容
const describe = (value) => (value ? `${value.length} 个字符` : "未设置");

const serverKey = read(SERVER_KEY);
const browserKey = read(BROWSER_KEY);
const proxyHost = read(PROXY_HOST);

const line = "─".repeat(56);
const problems = [];

if (serverKey && browserKey && serverKey === browserKey) {
  problems.push(
    [
      `${SERVER_KEY} 和 ${BROWSER_KEY} 填的是同一个 key。`,
      `  ${SERVER_KEY}            是服务端 WebService 用的（可配 IP 白名单，不该公开）`,
      `  ${BROWSER_KEY}  是浏览器加载地图 SDK 用的（必然下发到前端）`,
      "  两把填成一把，等于把服务端的 key 连同 JS 一起发给所有访客。",
      "  修法：去腾讯位置服务控制台再申请一个 key，浏览器那把配「域名白名单」，",
      "        服务端那把配「IP 白名单」，然后把两个变量改成不同的值。",
    ].join("\n"),
  );
}

if (serverKey && !browserKey && !proxyHost) {
  problems.push(
    [
      `只配了 ${SERVER_KEY}，浏览器端没有任何 key。`,
      "  页面能出数据，但底图会是空白（SDK 加载不到瓦片）。",
      `  补一个 ${BROWSER_KEY}（配域名白名单），或设 ${PROXY_HOST} 走代理模式。`,
    ].join("\n"),
  );
}

if (!serverKey && !browserKey && !proxyHost) {
  problems.push(
    [
      "key 相关的环境变量一个都没配。",
      "  后果：没有底图、没有真实 POI，只能看降级的示例数据。",
      "  复制 .env.example 成 .env.local，按里面的说明填。",
    ].join("\n"),
  );
}

const show = (name, value) =>
  `  ${name.padEnd(28)} ${value ? `已设置（${value.length} 字符）` : "未设置"}`;

if (problems.length === 0) {
  console.log("[check-env] 环境变量检查通过。");
  console.log(show(SERVER_KEY, serverKey));
  console.log(show(BROWSER_KEY, browserKey));
  if (proxyHost) console.log(show(PROXY_HOST, proxyHost));
} else {
  console.warn(line);
  console.warn("[check-env] 环境变量配置有问题：");
  console.warn("");
  for (const text of problems) console.warn(`· ${text}\n`);
  console.warn("当前状态：");
  console.warn(show(SERVER_KEY, serverKey));
  console.warn(show(BROWSER_KEY, browserKey));
  if (proxyHost) console.warn(show(PROXY_HOST, proxyHost));
  console.warn("");
  console.warn(line);
  console.warn("（这只是警告，不影响构建/启动。上面刻意只打印长度，不打印 key 内容。）");
}

// 永远 exit 0：这是防呆提示，不是门禁。
// 本地开发时因为一把没填就 build 不下去，只会逼着人把它注释掉，反而更糟。
process.exit(0);
