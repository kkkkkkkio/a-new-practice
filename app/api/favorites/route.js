// GET / POST / DELETE /api/favorites —— 当前浏览器的收藏夹。
//
// 「当前浏览器」靠 cookie 里的 session_id 认，没有账号体系：
// 同一个 session 只能看到自己的收藏，换一个浏览器就是另一份数据。

import { NextResponse, connection } from "next/server";
import { CATEGORIES } from "@/lib/categories";
import {
  FAVORITE_LIMIT,
  FavoriteLimitError,
  addFavorite,
  listFavorites,
  removeAllFavorites,
  removeFavorite,
} from "@/lib/db";
import { applySessionCookie, getOrCreateSessionId } from "@/lib/session";

// 这里**不能**写 export const runtime / dynamic：
// 本项目 next.config.mjs 开了 cacheComponents，它明确拒绝这两个 segment config
// （实测报错：Route segment config "runtime"/"dynamic" is not compatible with
// `nextConfig.cacheComponents`）。不开时默认运行时就是 nodejs，所以删掉等价。
//
// 取代 dynamic 的是下面的 await connection()：
// 开了 cacheComponents 后，GET Route Handler 只要不碰「请求期数据」，就可能在
// build 时被预渲染 —— 而 better-sqlite3 是同步的，预渲染时它会老老实实查一次库
// 并把结果定格进产物里，于是「收藏完刷新看不到变化，重启服务又好了」。
// connection() 的作用是「这一行之后必须等到真实请求才能继续」，把它放在最前面，
// 整个处理器就一定是每次请求现跑。

const NO_STORE = { "Cache-Control": "no-store" };

function fail(httpStatus, code, message) {
  return NextResponse.json({ error: { code, message } }, { status: httpStatus, headers: NO_STORE });
}

// 分类真源在 lib/categories.js，这里只做集合，绝不手抄一份 id 列表
// （手抄的下场是那边加了新分类，这边还在 400）
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

const LIMITS = { poi_id: 128, name: 100, address: 200, note: 200, source: 32 };

function str(value) {
  return typeof value === "string" ? value : "";
}

// 返回 { value } 或 { error: "..." }。只查「能不能入库」，不做任何业务加工。
function checkText(value, field, { required = true } = {}) {
  if (value === undefined || value === null) {
    return required
      ? { error: `${field} 不能为空` }
      : { value: null };
  }
  if (typeof value !== "string") return { error: `${field} 必须是字符串` };

  const trimmed = value.trim();
  if (required && !trimmed) return { error: `${field} 不能为空` };
  // 按 UTF-16 长度算，和 SQLite 存的字节数无关：这里约束的是「别塞进来一整篇文章」
  if (value.length > LIMITS[field]) {
    return { error: `${field} 最多 ${LIMITS[field]} 个字符` };
  }
  return { value: trimmed || null };
}

// 只收 JSON 里的数字类型，不做 Number() 宽松转换。
//
// 原来写的是 `typeof value === "number" ? value : Number(value)`，看着"兼容"，
// 实际上埋了两个坑：
//   1. Number("") === 0、Number(null) === 0 —— 前端漏传坐标会变成「几内亚湾 (0,0)」，
//      校验全过，一条错误的收藏就进库了；
//   2. Number("116.34") 能过，跟错误提示「必须是数字」自相矛盾。
// 请求体是 JSON，本来就有原生 number 类型，没有兼容字符串的必要，所以收紧。
// 注意：校验失败文案保持不变，前端直接展示它。
function checkNumber(value, field, min, max) {
  const ok = typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  if (!ok) {
    return { error: `${field} 必须是 ${min} 到 ${max} 之间的数字` };
  }
  return { value };
}

function parseBody(body) {
  const poi_id = checkText(body?.poi_id, "poi_id");
  if (poi_id.error) return poi_id;

  const source = checkText(body?.source, "source");
  if (source.error) return source;

  const name = checkText(body?.name, "name");
  if (name.error) return name;

  // 必须能在 CATEGORIES 里找到，否则地图上这个颜色画不出来
  const category = str(body?.category);
  if (!CATEGORY_IDS.has(category)) {
    return { error: `category 不在支持范围内：${category || "(空)"}` };
  }

  const lng = checkNumber(body?.lng, "lng", -180, 180);
  if (lng.error) return lng;

  const lat = checkNumber(body?.lat, "lat", -90, 90);
  if (lat.error) return lat;

  const address = checkText(body?.address, "address", { required: false });
  if (address.error) return address;

  const note = checkText(body?.note, "note", { required: false });
  if (note.error) return note;

  return {
    value: {
      poi_id: poi_id.value,
      source: source.value,
      name: name.value,
      category,
      lng: lng.value,
      lat: lat.value,
      address: address.value,
      note: note.value,
    },
  };
}

// 每个处理器都要先拿到 session：GET 时如果浏览器还没有 cookie，
// 这一步会顺手把它建出来（响应里带 Set-Cookie），下次请求就是同一个 session 了。
async function withSession(request) {
  // 必须在读库之前：见文件头，这一行保证整个处理器只在真实请求时执行
  await connection();
  const session = getOrCreateSessionId(request);
  return { session, done: (response) => applySessionCookie(response, session) };
}

export async function GET(request) {
  const { session, done } = await withSession(request);

  const items = listFavorites(session.sessionId, FAVORITE_LIMIT);
  return done(NextResponse.json({ items, limit: FAVORITE_LIMIT }, { headers: NO_STORE }));
}

export async function POST(request) {
  const { session, done } = await withSession(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return done(fail(400, "INVALID_BODY", "请求体必须是合法的 JSON"));
  }

  const parsed = parseBody(body);
  if (parsed.error) return done(fail(400, "INVALID_PARAM", parsed.error));

  try {
    const { item, created } = addFavorite(session.sessionId, parsed.value);
    return done(NextResponse.json({ item, created }, { headers: NO_STORE }));
  } catch (error) {
    if (error instanceof FavoriteLimitError) {
      return done(
        fail(429, "FAVORITE_LIMIT", `收藏夹最多 ${FAVORITE_LIMIT} 个地点，先删掉几个再收`),
      );
    }
    throw error;
  }
}

export async function DELETE(request) {
  const { session, done } = await withSession(request);

  const { searchParams } = new URL(request.url);

  // 全部清空（2026-10-29）。和路标的 ?all=1 一个口径：
  // 参数都不给才 400，给了 all=1 就明确是"全删"，不做「没传 id 就当全删」这种危险默认值。
  if (searchParams.get("all") === "1") {
    const deleted = removeAllFavorites(session.sessionId);
    return done(NextResponse.json({ deleted }, { headers: NO_STORE }));
  }

  const poiId = str(searchParams.get("poi_id")).trim();
  const source = str(searchParams.get("source")).trim();

  // 少了任一条件都可能是前端 bug（比如 source 忘了传），直接拒掉比"删了一堆东西"安全
  if (!poiId || !source) {
    return done(fail(400, "INVALID_PARAM", "poi_id 和 source 都必须传"));
  }

  removeFavorite(session.sessionId, poiId, source);
  // 本来就不存在也返回 204：前端点两次不会弹出"删除失败"
  return done(new NextResponse(null, { status: 204, headers: NO_STORE }));
}
