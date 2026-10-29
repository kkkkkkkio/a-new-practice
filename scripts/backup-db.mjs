// 在线备份 .data/pois.db —— 专门解决「WAL 模式下 cp 出来的是坏备份」这个坑。
//
// 为什么不能直接 cp：
//   journal_mode=WAL 时，最近的写入先落在 pois.db-wal 里，主库文件还是旧的。
//   只复制 pois.db 等于拿到一个「几天前的快照」，当前最近的收藏、缓存全都不在里面
//   （实测：cp 出来的备份里是 200 行旧的 bulk-* 测试数据，而没有当时唯一真实的 p036）。
//
// 这里的做法是 better-sqlite3 自带的 backup()：
//   它是 SQLite 的 Online Backup API，会连 -wal 里未合并的内容一起读出来，
//   而且不需要停服务、不需要独占锁，备份期间页面照常读写。
//
// 用法：
//   node scripts/backup-db.mjs            # 自动命名 .data/pois-20261028-203512.db
//   node scripts/backup-db.mjs 某个路径.db  # 指定目标（已存在会拒绝覆盖）
//
// 备份完会**自动校验**：打开备份文件，数一遍 favorite 表，并确认真实数据还在。

import Database from "better-sqlite3";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
// 路径只认 lib/db.js 那一份：那边支持 POI_DB_PATH，这边要是自己拼 .data/pois.db，
// 线上把库挪到数据盘之后，备份会去备一个不存在的（或者更糟，备一个空的旧库）。
// lib/db.js 顶层没有副作用（连接是懒初始化），import 它不会建库。
import { DB_PATH } from "../lib/db.js";

const DATA_DIR = dirname(DB_PATH);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

if (!existsSync(DB_PATH)) {
  console.error(`找不到数据库：${DB_PATH}`);
  console.error(
    "先跑一次 npm run dev 让应用建库；线上请确认 POI_DB_PATH 指对了，" +
      "以及进程的 cwd 没变（cwd 一变就会在别处新建一个空库）。",
  );
  process.exit(1);
}

const dest = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(DATA_DIR, `pois-${stamp()}.db`);

if (existsSync(dest)) {
  // 不覆盖：备份文件一旦被写坏就失去了「回滚点」的意义
  console.error(`目标文件已存在，拒绝覆盖：${dest}`);
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });

// 这行不是装饰：它解释了「为什么不能用 cp」，也让日志里能对上现场
const walPath = `${DB_PATH}-wal`;
const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
if (walBytes > 0) {
  console.log(
    `检测到 ${(walBytes / 1024).toFixed(0)} KB 的 ${walPath}：` +
      `最近的写入还在里面，只 cp 主库文件会丢掉这部分。`,
  );
}

const db = new Database(DB_PATH);
try {
  // 一定要 await：backup() 返回 Promise，同步返回时文件还没写完
  await db.backup(dest);
} finally {
  db.close();
}

// ── 校验 ────────────────────────────────────────────────────
// 关键一步：打开**备份文件**查，而不是查原库。查原库永远是对的，等于没校验。
const check = new Database(dest, { readonly: true });
let favoriteCount = 0;
let rows = [];
let ok = true;
try {
  favoriteCount = check.prepare("SELECT count(*) AS n FROM favorite").get().n;
  rows = check
    .prepare("SELECT session_id, poi_id, source FROM favorite ORDER BY id")
    .all();
  // 完整性自检：能发现「文件是数据库但内部页坏了」这种半损坏状态
  const integrity = check.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    console.error(`备份文件的 integrity_check 不通过：${integrity}`);
    ok = false;
  }
} catch (error) {
  console.error(`备份文件打不开或查不了表：${error.message}`);
  ok = false;
} finally {
  check.close();
}

const size = existsSync(dest) ? (statSync(dest).size / 1024).toFixed(0) : "?";

console.log(`\n备份完成：${dest}`);
console.log(`文件大小：${size} KB`);
console.log(`favorite 表：${favoriteCount} 行`);
if (rows.length > 0) {
  // 只打 poi_id，不打 session_id 全文：session 等于这份数据的钥匙
  const ids = rows.map((r) => r.poi_id).join(", ");
  console.log(`其中的 poi_id：${ids.length > 200 ? `${ids.slice(0, 200)}…` : ids}`);
}
if (favoriteCount === 0) {
  console.warn(
    "\n警告：备份里的收藏是空的。如果你本来就有收藏，说明这次备份没抓到最新数据，" +
      "别拿它去覆盖线上库。",
  );
}

if (!ok) process.exit(1);
