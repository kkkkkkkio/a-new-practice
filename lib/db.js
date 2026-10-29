// SQLite 缓存。用 better-sqlite3（同步 API，在 Node 运行时里最简单）。
//
// 关键：连接必须懒初始化 —— 第一次真正用到时才 open。
// 如果写在模块顶层，next build 阶段一 import 就会执行到，容易报目录不存在或权限错误。

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// 数据库文件位置。默认 <项目>/.data/pois.db（相对 process.cwd()）。
//
// 生产环境建议用环境变量 POI_DB_PATH 指到**代码目录之外**的数据盘，例如
//   POI_DB_PATH=/var/lib/poi-map/pois.db
// 理由三条，都是实测会咬人的：
//   1. .data/ 在 .gitignore 里 → 换目录重新 git clone / rsync --delete 覆盖，
//      数据文件跟着没，第一次请求会静默建一个**空库**（用户看到"收藏全没了"）；
//   2. 这个路径是相对 process.cwd() 的 → pm2 / systemd 的 cwd 没指对，就会在别处
//      新建一个空库，旧数据还在老目录里，但界面上什么都看不到；
//   3. 数据放数据盘，备份/迁移/扩盘都不用动代码。
// 相对路径按 process.cwd() 解析，绝对路径原样使用。
// 导出去给 scripts/backup-db.mjs 用 —— 备份必须备"同一个文件"，两处各写一份迟早对不上。
export const DB_PATH = process.env.POI_DB_PATH
  ? resolve(process.cwd(), process.env.POI_DB_PATH)
  : resolve(process.cwd(), ".data", "pois.db");
// 缓存 7 天。原来是 24 小时，但地点数据（尤其是餐厅、公交站）一周内基本不变，
// 而每次 2200m 的查询要花掉 200 次日额度里的 30 次 —— 缓存久一点是最直接的省法。
// 只要不删 .data 目录，同一组「起点 + 半径」一周内只向上游要一次。
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_MS = 30 * 24 * 60 * 60 * 1000; // 顺手清 30 天前的旧行（必须大于 TTL）

let db = null;

function getDb() {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  // 打印一次实际使用的文件（getDb 是懒初始化 + 缓存，一个进程只走一次）。
  // 线上"数据莫名其妙没了"最常见的原因就是进程 cwd 变了、在别处建了个空库 ——
  // 有这一行日志，看一眼 pm2 logs 就知道到底在读写哪个文件。
  console.log(`[db] 数据库：${DB_PATH}${process.env.POI_DB_PATH ? "（来自 POI_DB_PATH）" : ""}`);
  // WAL 能让读写同时进行，避免并发请求时互相阻塞
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS poi_cache (
      cache_key  TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      lng        REAL,
      lat        REAL,
      radius     INTEGER,
      hit        INTEGER NOT NULL,
      cost_ms    INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorite (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT    NOT NULL,
      poi_id     TEXT    NOT NULL,
      source     TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      category   TEXT    NOT NULL,
      lng        REAL    NOT NULL,
      lat        REAL    NOT NULL,
      address    TEXT,
      note       TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, poi_id, source)
    );
    CREATE INDEX IF NOT EXISTS idx_favorite_session ON favorite(session_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS waypoint (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT    NOT NULL,
      lng        REAL    NOT NULL,
      lat        REAL    NOT NULL,
      label      TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_waypoint_session ON waypoint(session_id, created_at);
    -- 打卡（2026-10-29）。结构基本照抄 favorite：都是「用户对某个地点做的标记」，
    -- 区别是打卡多一个 label（列表里可以改名，而 favorite 的 name 是上游快照，不改）。
    -- 这里允许 source = 'waypoint'、poi_id = 'wp:12' 的组合，用来给用户自己放的路标打卡。
    CREATE TABLE IF NOT EXISTS checkin (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT    NOT NULL,
      poi_id     TEXT    NOT NULL,
      source     TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      category   TEXT    NOT NULL,
      lng        REAL    NOT NULL,
      lat        REAL    NOT NULL,
      address    TEXT,
      label      TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, poi_id, source)
    );
    CREATE INDEX IF NOT EXISTS idx_checkin_session ON checkin(session_id, created_at DESC);
  `);

  return db;
}

// 经纬度固定 4 位小数再拼 key：浮点抖动（116.348 和 116.3480000001）不能变成两次 miss。
// 末尾必须带数据源：mock 和真实 POI 是完全不同的两批点，共用同一个 key 会串味
// （实测踩过 —— 切回真实 key 后照样返回「示例·餐饮 01」）。
export function makeCacheKey(lng, lat, radius, source = "tencent") {
  return `${Number(lng).toFixed(4)},${Number(lat).toFixed(4)},${radius},${source}`;
}

export function readCache(cacheKey) {
  const row = getDb()
    .prepare("SELECT payload, fetched_at FROM poi_cache WHERE cache_key = ?")
    .get(cacheKey);
  if (!row) return null;

  const age = Date.now() - row.fetched_at;
  if (age > CACHE_TTL_MS) return null; // 过期当作没有

  return { payload: JSON.parse(row.payload), fetchedAt: row.fetched_at };
}

export function writeCache(cacheKey, payload) {
  const now = Date.now();
  const conn = getDb();

  conn
    .prepare(
      `INSERT INTO poi_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
    )
    .run(cacheKey, JSON.stringify(payload), now);

  // 不引定时任务，写缓存时顺手清掉过期太久的行
  conn.prepare("DELETE FROM poi_cache WHERE fetched_at < ?").run(now - PRUNE_MS);
}

export function logRequest({ lng, lat, radius, hit, costMs }) {
  getDb()
    .prepare(
      "INSERT INTO request_log (lng, lat, radius, hit, cost_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(lng, lat, radius, hit ? 1 : 0, costMs, Date.now());
}

// ─────────────────────────────────────────────────────────────
// 收藏夹。这是项目里第一份「用户数据」——不是缓存、不是日志，删了就找不回来。
// ─────────────────────────────────────────────────────────────

// 上限写在服务端，前端只是照着这个数提示，不能由前端说了算。
export const FAVORITE_LIMIT = 200;

// GET 返回的字段。id 也带上，前端做列表 key 时比 poi_id 稳（同一个 poi 可以有两个 source）
const FAVORITE_COLUMNS = "id, poi_id, source, name, category, lng, lat, address, note, created_at";

export class FavoriteLimitError extends Error {
  constructor(limit = FAVORITE_LIMIT) {
    super(`一个会话最多收藏 ${limit} 个地点`);
    this.name = "FavoriteLimitError";
    this.limit = limit;
  }
}

export function countFavorites(sessionId) {
  return getDb()
    .prepare("SELECT count(*) AS n FROM favorite WHERE session_id = ?")
    .get(sessionId).n;
}

export function listFavorites(sessionId, limit = FAVORITE_LIMIT) {
  // created_at 只到毫秒，连着点两下可能同毫秒，补一个 id DESC 保证顺序稳定
  return getDb()
    .prepare(
      `SELECT ${FAVORITE_COLUMNS} FROM favorite
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(sessionId, limit);
}

/**
 * 幂等收藏：已经收过就返回原来那条，created=false。
 *
 * 去重完全交给 UNIQUE(session_id, poi_id, source) + ON CONFLICT DO NOTHING：
 * 「先 SELECT 再 INSERT」在并发下两个请求会同时查空、同时插入，最后变成两条。
 *
 * 名额判断放在插完之后数一遍，超了抛异常让事务整体回滚 —— 这样就不用为了
 * 「查名额」先做一次 SELECT，幂等和限额各自只有一处真相。
 */
export function addFavorite(sessionId, poi) {
  const conn = getDb();

  const insert = conn.prepare(
    `INSERT INTO favorite (session_id, poi_id, source, name, category, lng, lat, address, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, poi_id, source) DO NOTHING
     RETURNING ${FAVORITE_COLUMNS}`,
  );
  const select = conn.prepare(
    `SELECT ${FAVORITE_COLUMNS} FROM favorite
     WHERE session_id = ? AND poi_id = ? AND source = ?`,
  );
  const count = conn.prepare("SELECT count(*) AS n FROM favorite WHERE session_id = ?");

  // better-sqlite3 是同步的，transaction() 里的几条语句之间不会有别的请求插进来
  const run = conn.transaction(() => {
    const row = insert.get(
      sessionId,
      poi.poi_id,
      poi.source,
      poi.name,
      poi.category,
      poi.lng,
      poi.lat,
      poi.address ?? null,
      poi.note ?? null,
      Date.now(),
    );

    // 已经有这条（返回值是 undefined 说明被 UNIQUE 挡了），直接还回去
    if (!row) {
      return { item: select.get(sessionId, poi.poi_id, poi.source), created: false };
    }

    if (count.get(sessionId).n > FAVORITE_LIMIT) throw new FavoriteLimitError();
    return { item: row, created: true };
  });

  return run();
}

/** 删除同样幂等：本来就没有也当成功，前端不用区分「删过了」和「删掉了」。 */
export function removeFavorite(sessionId, poiId, source) {
  return getDb()
    .prepare("DELETE FROM favorite WHERE session_id = ? AND poi_id = ? AND source = ?")
    .run(sessionId, poiId, source).changes;
}

/** 全部删除（2026-10-29）。返回删掉几条 —— 前端要据此判断"撤销"还有没有意义。 */
export function removeAllFavorites(sessionId) {
  return getDb().prepare("DELETE FROM favorite WHERE session_id = ?").run(sessionId).changes;
}

// ─────────────────────────────────────────────────────────────
// 路标（第二轮需求 6/7）。用户在地图上手动放的点，**必须入库** ——
// 需求明确写着「刷新后手动添加的路标仍然存在」，纯前端状态做不到这点。
//
// 而「撤销栈」反过来**不入库**：需求要求「刷新后撤销次数不恢复」，
// 把栈放内存里天然满足，重启浏览器就清空。
// ─────────────────────────────────────────────────────────────

export const WAYPOINT_LIMIT = 50;

const WAYPOINT_COLUMNS = "id, lng, lat, label, created_at";

export function listWaypoints(sessionId, limit = WAYPOINT_LIMIT) {
  // 按放下的顺序返回：路标是有先后的（第一个、第二个……），最新放的在最后
  return getDb()
    .prepare(
      `SELECT ${WAYPOINT_COLUMNS} FROM waypoint
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(sessionId, limit);
}

export function countWaypoints(sessionId) {
  return getDb()
    .prepare("SELECT count(*) AS n FROM waypoint WHERE session_id = ?")
    .get(sessionId).n;
}

export class WaypointLimitError extends Error {
  constructor(limit = WAYPOINT_LIMIT) {
    super(`最多只能放 ${limit} 个路标，先删掉几个`);
    this.name = "WaypointLimitError";
    this.limit = limit;
  }
}

export function addWaypoint(sessionId, { lng, lat, label }) {
  const conn = getDb();
  const insert = conn.prepare(
    `INSERT INTO waypoint (session_id, lng, lat, label, created_at)
     VALUES (?, ?, ?, ?, ?)
     RETURNING ${WAYPOINT_COLUMNS}`,
  );
  const count = conn.prepare("SELECT count(*) AS n FROM waypoint WHERE session_id = ?");

  // 名额判断放在插入之后数一遍，超了抛异常整体回滚 —— 和收藏夹一个套路
  return conn.transaction(() => {
    const row = insert.get(sessionId, lng, lat, label ?? null, Date.now());
    if (count.get(sessionId).n > WAYPOINT_LIMIT) throw new WaypointLimitError();
    return row;
  })();
}

/** 删一个。带 session_id 条件，别人的 id 递进来也删不到。 */
export function removeWaypoint(sessionId, id) {
  return getDb()
    .prepare("DELETE FROM waypoint WHERE session_id = ? AND id = ?")
    .run(sessionId, id).changes;
}

/** 拖到新位置。同样只改自己会话里的那条。 */
export function moveWaypoint(sessionId, id, lng, lat) {
  return getDb()
    .prepare("UPDATE waypoint SET lng = ?, lat = ? WHERE session_id = ? AND id = ?")
    .run(lng, lat, sessionId, id).changes;
}

/**
 * 改名。和 moveWaypoint 分成两个函数而不是一个「随便改点什么」的：
 * 拖动的调用点只会传坐标，改名的调用点只会传名字，混在一起容易出现
 * 「只想改名却被写成 (undefined, undefined) 把坐标抹掉」这种事。
 * label 传 null 表示恢复默认（前端显示成「路标 N」）。
 */
export function renameWaypoint(sessionId, id, label) {
  return getDb()
    .prepare("UPDATE waypoint SET label = ? WHERE session_id = ? AND id = ?")
    .run(label, sessionId, id).changes;
}

/** 全部删除，返回删掉几个。 */
export function removeAllWaypoints(sessionId) {
  return getDb().prepare("DELETE FROM waypoint WHERE session_id = ?").run(sessionId).changes;
}

// ─────────────────────────────────────────────────────────────
// 打卡（2026-10-29）。和收藏几乎一样，两点不同：
//   1. 有 label —— 列表里可以改名，改的是「我给这地方起的名字」，
//      不动 name（那是上游快照，改了下次从 POI 弹窗看就对不上了）；
//   2. 允许给用户自己放的路标打卡：source = 'waypoint'、poi_id = 'wp:<路标 id>'。
//      这样「只看全部打卡」能把 POI 和路标混在一张列表里，不用两套表。
// ─────────────────────────────────────────────────────────────

export const CHECKIN_LIMIT = 200;

const CHECKIN_COLUMNS = "id, poi_id, source, name, category, lng, lat, address, label, created_at";

export class CheckinLimitError extends Error {
  constructor(limit = CHECKIN_LIMIT) {
    super(`一个会话最多打卡 ${limit} 个地点`);
    this.name = "CheckinLimitError";
    this.limit = limit;
  }
}

export function listCheckins(sessionId, limit = CHECKIN_LIMIT) {
  // 最近打的在最上面；created_at 只到毫秒，同毫秒补 id DESC 保证顺序稳定
  return getDb()
    .prepare(
      `SELECT ${CHECKIN_COLUMNS} FROM checkin
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(sessionId, limit);
}

/** 幂等打卡：已经打过就返回原来那条，created=false（和收藏同一个套路）。 */
export function addCheckin(sessionId, item) {
  const conn = getDb();

  const insert = conn.prepare(
    `INSERT INTO checkin (session_id, poi_id, source, name, category, lng, lat, address, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, poi_id, source) DO NOTHING
     RETURNING ${CHECKIN_COLUMNS}`,
  );
  const select = conn.prepare(
    `SELECT ${CHECKIN_COLUMNS} FROM checkin WHERE session_id = ? AND poi_id = ? AND source = ?`,
  );
  const count = conn.prepare("SELECT count(*) AS n FROM checkin WHERE session_id = ?");

  const run = conn.transaction(() => {
    const row = insert.get(
      sessionId,
      item.poi_id,
      item.source,
      item.name,
      item.category,
      item.lng,
      item.lat,
      item.address ?? null,
      item.label ?? null,
      Date.now(),
    );
    if (!row) {
      return { item: select.get(sessionId, item.poi_id, item.source), created: false };
    }
    if (count.get(sessionId).n > CHECKIN_LIMIT) throw new CheckinLimitError();
    return { item: row, created: true };
  });

  return run();
}

/**
 * 取消打卡。两种入口都要：
 *   removeCheckinById    —— 面板列表里点「删除」（只知道行 id）
 *   removeCheckinByPoi   —— 弹窗里再点一次「已打卡」（只知道它是哪个地点）
 * 都带 session_id 条件，别人的 id 递进来也删不到。
 */
export function removeCheckinById(sessionId, id) {
  return getDb()
    .prepare("DELETE FROM checkin WHERE session_id = ? AND id = ?")
    .run(sessionId, id).changes;
}

export function removeCheckinByPoi(sessionId, poiId, source) {
  return getDb()
    .prepare("DELETE FROM checkin WHERE session_id = ? AND poi_id = ? AND source = ?")
    .run(sessionId, poiId, source).changes;
}

export function renameCheckin(sessionId, id, label) {
  return getDb()
    .prepare("UPDATE checkin SET label = ? WHERE session_id = ? AND id = ?")
    .run(label, sessionId, id).changes;
}

export function removeAllCheckins(sessionId) {
  return getDb().prepare("DELETE FROM checkin WHERE session_id = ?").run(sessionId).changes;
}
