// SQLite 缓存。用 better-sqlite3（同步 API，在 Node 运行时里最简单）。
//
// 关键：连接必须懒初始化 —— 第一次真正用到时才 open。
// 如果写在模块顶层，next build 阶段一 import 就会执行到，容易报目录不存在或权限错误。

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DB_PATH = resolve(process.cwd(), ".data", "pois.db");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 缓存 24 小时
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000; // 顺手清 7 天前的旧行

let db = null;

function getDb() {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
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
  `);

  return db;
}

// 经纬度固定 4 位小数再拼 key：浮点抖动（116.348 和 116.3480000001）不能变成两次 miss
export function makeCacheKey(lng, lat, radius) {
  return `${Number(lng).toFixed(4)},${Number(lat).toFixed(4)},${radius}`;
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
