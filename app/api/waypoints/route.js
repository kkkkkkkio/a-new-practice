// GET / POST / DELETE /api/waypoints —— 当前浏览器放的地图路标。
//
// 需求 7 把这件事拆成了两半：
//   - 路标本身  → 入库（刷新后还在）
//   - 撤销栈    → 只在前端内存里（刷新即失去撤销能力）
// 所以这个接口只管「增删查」，完全不提供撤销历史 —— 撤销是前端把删掉的路标
// 按原坐标重新 POST 一次，天经地义地不会跨刷新存活。
//
// 「当前浏览器」和收藏夹一样靠 cookie 里的 session_id 认（需求 8 的多用户隔离），
// 所有语句都带 session_id 条件，别人的 id 递进来也删不到。

import { NextResponse, connection } from "next/server";
import {
  WAYPOINT_LIMIT,
  WaypointLimitError,
  addWaypoint,
  listWaypoints,
  moveWaypoint,
  removeAllWaypoints,
  removeWaypoint,
  renameWaypoint,
} from "@/lib/db";
import { applySessionCookie, getOrCreateSessionId } from "@/lib/session";

// 同样不能写 export const runtime / dynamic（cacheComponents 拒绝），
// 用 await connection() 保证每次请求现跑，见 app/api/favorites/route.js 的说明。
const NO_STORE = { "Cache-Control": "no-store" };

function fail(httpStatus, code, message) {
  return NextResponse.json({ error: { code, message } }, { status: httpStatus, headers: NO_STORE });
}

const LABEL_MAX = 40;

function checkNumber(value, field, min, max) {
  const ok = typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  if (!ok) return { error: `${field} 必须是 ${min} 到 ${max} 之间的数字` };
  return { value };
}

async function withSession(request) {
  await connection();
  const session = getOrCreateSessionId(request);
  return { session, done: (response) => applySessionCookie(response, session) };
}

export async function GET(request) {
  const { session, done } = await withSession(request);
  const items = listWaypoints(session.sessionId, WAYPOINT_LIMIT);
  return done(NextResponse.json({ items, limit: WAYPOINT_LIMIT }, { headers: NO_STORE }));
}

export async function POST(request) {
  const { session, done } = await withSession(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return done(fail(400, "INVALID_BODY", "请求体必须是合法的 JSON"));
  }

  const lng = checkNumber(body?.lng, "lng", -180, 180);
  if (lng.error) return done(fail(400, "INVALID_PARAM", lng.error));

  const lat = checkNumber(body?.lat, "lat", -90, 90);
  if (lat.error) return done(fail(400, "INVALID_PARAM", lat.error));

  // 名称可以不传（路标默认就叫「路标 1」之类，由前端编号），传了就得是短字符串
  let label = null;
  if (body?.label !== undefined && body?.label !== null) {
    if (typeof body.label !== "string") {
      return done(fail(400, "INVALID_PARAM", "label 必须是字符串"));
    }
    label = body.label.trim().slice(0, LABEL_MAX) || null;
  }

  try {
    const item = addWaypoint(session.sessionId, { lng: lng.value, lat: lat.value, label });
    return done(NextResponse.json({ item }, { headers: NO_STORE }));
  } catch (error) {
    if (error instanceof WaypointLimitError) {
      return done(fail(429, "WAYPOINT_LIMIT", error.message));
    }
    throw error;
  }
}

/**
 * PATCH { id, lng, lat }  —— 拖动路标后保存新位置。
 * PATCH { id, label }     —— 改名（2026-10-29 新增）。
 *
 * 用一个动词两种载荷，而不是再开个 /rename 子路由：都是"改这一条路标的某个字段"，
 * 前端也只需要记一个地址。判别靠载荷里有没有坐标：
 *   带了 lng/lat → 移动；没带、只带 label → 改名；两样都没有 → 400。
 *
 * 移动之所以不用「删了再建」：那样每次拖动都会换 id，
 * 而且中间有一瞬间是两个路标的状态。
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

  const wantsMove = body?.lng !== undefined || body?.lat !== undefined;

  if (wantsMove) {
    const lng = checkNumber(body?.lng, "lng", -180, 180);
    if (lng.error) return done(fail(400, "INVALID_PARAM", lng.error));

    const lat = checkNumber(body?.lat, "lat", -90, 90);
    if (lat.error) return done(fail(400, "INVALID_PARAM", lat.error));

    const updated = moveWaypoint(session.sessionId, id, lng.value, lat.value);
    // 查不到（别人的 id / 已经删了）就 404，让前端知道这次拖动没存上
    if (!updated) return done(fail(404, "NOT_FOUND", "这个路标不存在或已被删除"));

    return done(NextResponse.json({ updated }, { headers: NO_STORE }));
  }

  if (body?.label === undefined) {
    return done(fail(400, "INVALID_PARAM", "要么给 lng/lat（移动），要么给 label（改名）"));
  }
  if (body.label !== null && typeof body.label !== "string") {
    return done(fail(400, "INVALID_PARAM", "label 必须是字符串或 null"));
  }

  // 和 POST 用同一套规则：去空白、截断、空串当"没有名字"
  const label =
    body.label === null ? null : String(body.label).trim().slice(0, LABEL_MAX) || null;

  const renamed = renameWaypoint(session.sessionId, id, label);
  if (!renamed) return done(fail(404, "NOT_FOUND", "这个路标不存在或已被删除"));

  return done(NextResponse.json({ renamed, label }, { headers: NO_STORE }));
}

/**
 * DELETE ?id=12     删一个
 * DELETE ?all=1     全部删除（需求 6 的「点击路标图标可执行全部删除」）
 *
 * 两个参数都不给就 400：宁可报错，也不做「没传 id 就当全删」这种危险默认值。
 */
export async function DELETE(request) {
  const { session, done } = await withSession(request);

  const { searchParams } = new URL(request.url);
  const idRaw = searchParams.get("id");
  const all = searchParams.get("all");

  if (all === "1") {
    const deleted = removeAllWaypoints(session.sessionId);
    return done(NextResponse.json({ deleted }, { headers: NO_STORE }));
  }

  const id = Number(idRaw);
  if (!idRaw || !Number.isInteger(id) || id <= 0) {
    return done(fail(400, "INVALID_PARAM", "要么传 id（整数），要么传 all=1"));
  }

  const deleted = removeWaypoint(session.sessionId, id);
  return done(NextResponse.json({ deleted }, { headers: NO_STORE }));
}
