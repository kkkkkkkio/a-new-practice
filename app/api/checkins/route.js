// GET / POST / DELETE / PATCH /api/checkins —— 当前浏览器的打卡记录。
//
// 和收藏夹（app/api/favorites）几乎同构，三处不同：
//   1. 多一个 label：列表里能改名。改的是「我给这个地方起的名字」，
//      不动 name（name 是上游快照，改了下次从弹窗看就对不上了）；
//   2. 允许 source = 'waypoint'、poi_id = 'wp:12' —— 用户自己放的路标也能打卡；
//   3. 取消打卡有两个入口：列表里按行 id 删、弹窗里按 (poi_id, source) 取消。
//
// 「当前浏览器」同样靠 cookie 里的 session_id 认，没有账号体系。

import { NextResponse, connection } from "next/server";
import { CATEGORIES } from "@/lib/categories";
import {
  CHECKIN_LIMIT,
  CheckinLimitError,
  addCheckin,
  listCheckins,
  removeAllCheckins,
  removeCheckinById,
  removeCheckinByPoi,
  renameCheckin,
} from "@/lib/db";
import { applySessionCookie, getOrCreateSessionId } from "@/lib/session";

// 不能写 export const runtime / dynamic：本项目开了 cacheComponents，它明确拒绝这两个
// segment config。用 await connection() 保证每次请求现跑，原因见 favorites/route.js 顶部。
const NO_STORE = { "Cache-Control": "no-store" };

function fail(httpStatus, code, message) {
  return NextResponse.json({ error: { code, message } }, { status: httpStatus, headers: NO_STORE });
}

// 分类真源在 lib/categories.js。多出来的 "waypoint" 是「自己放的路标」这个伪分类 ——
// 它不对应任何真实 POI，只在打卡列表里出现，所以只在这里补，不去污染 CATEGORIES
//（那边一动，筛选栏的 7 个类型也要跟着变）。
const CATEGORY_IDS = new Set([...CATEGORIES.map((c) => c.id), "waypoint"]);

const LIMITS = { poi_id: 128, name: 100, address: 200, label: 40, source: 32 };

function str(value) {
  return typeof value === "string" ? value : "";
}

function checkText(value, field, { required = true } = {}) {
  if (value === undefined || value === null) {
    return required ? { error: `${field} 不能为空` } : { value: null };
  }
  if (typeof value !== "string") return { error: `${field} 必须是字符串` };

  const trimmed = value.trim();
  if (required && !trimmed) return { error: `${field} 不能为空` };
  if (value.length > LIMITS[field]) {
    return { error: `${field} 最多 ${LIMITS[field]} 个字符` };
  }
  return { value: trimmed || null };
}

// 只收 JSON 原生 number，不做 Number() 宽松转换（"" 和 null 会变成 0 —— 详见 favorites 那边的注释）
function checkNumber(value, field, min, max) {
  const ok = typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  if (!ok) return { error: `${field} 必须是 ${min} 到 ${max} 之间的数字` };
  return { value };
}

function parseBody(body) {
  const poi_id = checkText(body?.poi_id, "poi_id");
  if (poi_id.error) return poi_id;

  const source = checkText(body?.source, "source");
  if (source.error) return source;

  const name = checkText(body?.name, "name");
  if (name.error) return name;

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

  const label = checkText(body?.label, "label", { required: false });
  if (label.error) return label;

  return {
    value: {
      poi_id: poi_id.value,
      source: source.value,
      name: name.value,
      category,
      lng: lng.value,
      lat: lat.value,
      address: address.value,
      label: label.value,
    },
  };
}

async function withSession(request) {
  await connection();
  const session = getOrCreateSessionId(request);
  return { session, done: (response) => applySessionCookie(response, session) };
}

export async function GET(request) {
  const { session, done } = await withSession(request);
  const items = listCheckins(session.sessionId, CHECKIN_LIMIT);
  return done(NextResponse.json({ items, limit: CHECKIN_LIMIT }, { headers: NO_STORE }));
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
    const { item, created } = addCheckin(session.sessionId, parsed.value);
    return done(NextResponse.json({ item, created }, { headers: NO_STORE }));
  } catch (error) {
    if (error instanceof CheckinLimitError) {
      return done(fail(429, "CHECKIN_LIMIT", `打卡最多 ${CHECKIN_LIMIT} 个地点，先删掉几个`));
    }
    throw error;
  }
}

/**
 * PATCH { id, label } —— 改名。label 传 null / 空串表示恢复默认（显示 POI 原名）。
 */
export async function PATCH(request) {
  const { session, done } = await withSession(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return done(fail(400, "INVALID_BODY", "请求体必须是合法的 JSON"));
  }

  const id = body?.id;
  if (!Number.isInteger(id) || id <= 0) {
    return done(fail(400, "INVALID_PARAM", "id 必须是正整数"));
  }
  if (body?.label === undefined) {
    return done(fail(400, "INVALID_PARAM", "要传 label（改名）"));
  }
  if (body.label !== null && typeof body.label !== "string") {
    return done(fail(400, "INVALID_PARAM", "label 必须是字符串或 null"));
  }

  const label = body.label === null ? null : String(body.label).trim().slice(0, 40) || null;
  const renamed = renameCheckin(session.sessionId, id, label);
  if (!renamed) return done(fail(404, "NOT_FOUND", "这条打卡不存在或已被删除"));

  return done(NextResponse.json({ renamed, label }, { headers: NO_STORE }));
}

/**
 * DELETE ?id=12                     —— 列表里删一条
 * DELETE ?poi_id=xxx&source=yyy     —— 弹窗里取消打卡（只知道是哪个地点）
 */
export async function DELETE(request) {
  const { session, done } = await withSession(request);
  const { searchParams } = new URL(request.url);

  // 全部清空（2026-10-29），口径同收藏/路标：只认显式的 all=1
  if (searchParams.get("all") === "1") {
    const deleted = removeAllCheckins(session.sessionId);
    return done(NextResponse.json({ deleted }, { headers: NO_STORE }));
  }

  const idRaw = searchParams.get("id");

  if (idRaw) {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return done(fail(400, "INVALID_PARAM", "id 必须是正整数"));
    }
    const deleted = removeCheckinById(session.sessionId, id);
    return done(NextResponse.json({ deleted }, { headers: NO_STORE }));
  }

  const poiId = str(searchParams.get("poi_id")).trim();
  const source = str(searchParams.get("source")).trim();
  // 少了任一条件都可能是前端 bug（比如 source 忘了传），直接拒掉比"删了一堆东西"安全
  if (!poiId || !source) {
    return done(fail(400, "INVALID_PARAM", "要么传 id，要么 poi_id 和 source 一起传"));
  }

  // 本来就没有也当成功：前端点两次不该弹出"取消失败"
  const deleted = removeCheckinByPoi(session.sessionId, poiId, source);
  return done(NextResponse.json({ deleted }, { headers: NO_STORE }));
}
