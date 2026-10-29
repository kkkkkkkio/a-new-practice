This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.js`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## 本地配置（必读）

复制 `.env.example` 为 `.env.local` 再填。**改完要重启 dev server**；`NEXT_PUBLIC_*` 还会被写进构建产物，生产环境修改后要重新 build。

### 两个 key 必须是两个不同的 key

| 变量 | 用途 | 鉴权方式 | 会不会下发到浏览器 |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_TMAP_KEY` | 浏览器加载地图 GL JS SDK | 域名白名单 | **会**，必然公开 |
| `TENCENT_MAP_KEY` | 服务端调 WebService 周边搜索 | IP 白名单 | 不会（只要别复用） |

`NEXT_PUBLIC_` 前缀的意义就是「这个变量会被打进前端 JS」，无法避免。所以真正的坑不是用了前缀，而是**两个变量填了同一个值**：那样服务端那把 key 就会跟着 JS 一起下发给每个访客，抓包即得。

更麻烦的是，产物里只有 key 的值、没有变量名，所以 `grep TENCENT_MAP_KEY .next/static` 是查不出来的（实测）。想确认有没有泄漏，只能直接搜 key 的值本身。

防呆检查：

```bash
npm run check:env
```

两个变量值相同会大声警告（只打印长度、不打印内容，不会把 key 打进日志）。这个检查挂在 `prebuild` 上，`npm run build` 会自动跑一次；它**只警告、不 fail**，避免因为一个提示卡住本地开发。

## 数据库与备份

数据库在 `.data/pois.db`（WAL 模式），里面有两类东西：`poi_cache` / `request_log` 是可再生的缓存和日志，`favorite` 表是**唯一的用户数据**，删了就没了。

### 不要用 `cp pois.db` 做备份

WAL 模式下，最近的写入先追加到 `pois.db-wal`，主库文件还是旧的。只复制 `pois.db` 拿到的是几天前的旧快照，最新的收藏不在里面（实测：`cp` 出来的备份里是 200 行早已清掉的 `bulk-*` 测试数据，而没有当时唯一真实的 `p036`）。

正确做法：

```bash
npm run db:backup              # 生成 .data/pois-20261028-203512.db
node scripts/backup-db.mjs 自定义路径.db   # 也可以指定目标，已存在会拒绝覆盖
```

脚本走 SQLite 的 Online Backup API（`db.backup()`），会连 `-wal` 里未合并的内容一起读，**不用停服务**。备份完它会自动打开备份文件校验：数一遍 `favorite` 行数、列出 `poi_id`、跑一次 `integrity_check` —— 校验的是备份文件本身，不是原库。

> `.data/pois.db.bak` 是一次错误 `cp` 留下的过期副本，**不要拿它恢复**，会丢掉当前真实收藏。确认没用了可以直接删。

## 地点数据从哪来

地图页的点位不是实时查的，而是读 `public/data/pois-snapshot.json` 这份静态快照（后端按「起点 + 半径」现算距离筛选）。好处是零调用、不过期、换起点不用重新抓。

两个脚本都能生成它，二选一：

| 脚本 | 数据源 | 需要 key | 成本 |
| --- | --- | --- | --- |
| `node scripts/snapshot-osm.mjs` | OpenStreetMap | 不需要 | 一次 Overpass 查询，约 1 分钟 |
| `node --env-file=.env.local scripts/snapshot-pois.mjs` | 腾讯位置服务 | 需要 | 最多 156 次调用，个人额度 200 次/日 |

腾讯那个虽然数据更贴近国内地图 App，但额度用完当天就没法再抓（还会出现 `limit_pv=0` 这种「key 没分配到额度」的情况，得去控制台处理）。所以平时用 OSM 那个更省心。

**OSM 数据必须注意坐标系**：OSM 存 WGS-84，腾讯地图 GL JS 认 GCJ-02（火星坐标），不转换会整体偏移 500 多米。`snapshot-osm.mjs` 里已经用标准算法转过了，改脚本时别把这一步删掉。

> 数据来源：© OpenStreetMap contributors，[ODbL](https://www.openstreetmap.org/copyright)。这条署名要求是硬性的，正式对外发布时请在地图角落标出来。

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
