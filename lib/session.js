// 匿名会话：没有登录，但「谁收藏了什么」必须能区分开，所以给每个浏览器发一个随机 id。
//
// 为什么用 cookie 而不是 localStorage：
//   httpOnly 的 cookie 前端 JS 读不到，脚本注入也偷不走。session_id 等同于这份用户数据的钥匙，
//   不该放在 JS 能任意读写的 localStorage 里。

import { randomUUID } from "node:crypto";

export const SESSION_COOKIE = "sid";

// 180 天。收藏是「想起来才看」的功能，太短会让人莫名其妙丢数据。
const MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

// 只认标准 UUID（v1~v5）。宽松匹配会把 "abc" 这种手改的垃圾值也收下，
// 那 session 就退化成用户可以随便指定的字符串了。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function serializeCookie(sessionId, { secure }) {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    // 三项：JS 读不到、跨站 POST 不带、只在同站生效
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];

  // Secure 必须**跟着这次请求的真实协议**走，不能只看 NODE_ENV。
  // 原来写的是 `if (NODE_ENV === "production")`，在「服务器 IP + http 直接访问」时是错的：
  // 浏览器收到 `Set-Cookie: ...; Secure` 而页面是 http，会把这个 cookie 直接丢掉，
  // 于是每次刷新都当新用户 → 表现就是「我收藏了，下次进来又空了」
  // （数据其实在库里，只是每次多一条认不出主人的记录）。
  if (secure) parts.push("Secure");

  return parts.join("; ");
}

// 这次请求是不是走的 https。
//
// 反向代理（Nginx / Caddy / 云负载均衡）终结 TLS 时，Node 看到的连接是 http，
// 真实协议在 x-forwarded-proto 里，所以先看这个头，没有再看请求自身的 URL。
// 反代配置里要带上 `proxy_set_header X-Forwarded-Proto $scheme;`，否则这里会退化成 http。
function isHttpsRequest(request) {
  const forwarded = request.headers?.get?.("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim().toLowerCase() === "https";

  try {
    return request.nextUrl?.protocol === "https:";
  } catch {
    // nextUrl 在人为构造的 Request 上可能抛（缺 base）。按 http 处理：
    // 少一个 Secure 只是安全性降一档，加错的代价是「收藏功能整个坏掉」。
    return false;
  }
}

// 线上还在裸 http 时提醒一次（只提醒一次，别刷日志）。
let warnedInsecure = false;
function warnOnceIfInsecure(secure) {
  if (secure || warnedInsecure || process.env.NODE_ENV !== "production") return;
  warnedInsecure = true;
  console.warn(
    "[session] 线上用的是 http：sid cookie 没有加 Secure，明文传输且换域名会丢会话。建议尽快上 https。",
  );
}

/**
 * 取当前请求的会话 id；没有或非法就生成一个新的。
 *
 * 返回 { sessionId, isNew, setCookie }：
 *   setCookie 是待写入的 Set-Cookie 字符串，只有新建时才不为 null。
 *   之所以不在这里直接写响应 —— 本函数拿不到还没创建出来的 Response。
 *
 * 读 request.cookies 是同步的（NextRequest 上的 RequestCookies），
 * 和 next/headers 里那个异步的 cookies() 不是一回事，这里不需要 await。
 */
export function getOrCreateSessionId(request) {
  const existing = request.cookies?.get(SESSION_COOKIE)?.value;

  // 原样返回，不做大小写归一：改写了就等于换个 session，用户的收藏会突然"消失"
  if (existing && UUID_RE.test(existing)) {
    return { sessionId: existing, isNew: false, setCookie: null };
  }

  const secure = isHttpsRequest(request);
  warnOnceIfInsecure(secure);

  const sessionId = randomUUID();
  return { sessionId, isNew: true, setCookie: serializeCookie(sessionId, { secure }) };
}

/**
 * 把新建会话的 cookie 挂到响应上。
 * 用 append 而不是 set：后面可能还有别的 Set-Cookie，覆盖会把它们挤掉。
 */
export function applySessionCookie(response, session) {
  if (session.setCookie) response.headers.append("set-cookie", session.setCookie);
  return response;
}
