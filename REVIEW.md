# 验收说明 · 地图数据源切到 OSM + 只保留真实数据 + 署名

> 项目：`C:\Users\ASUS\Desktop\new folder`（Next.js 16.4.1 App Router + React 19 + better-sqlite3）
> 日期：2026-10-29　提交范围：本文件对应的未提交改动
> 给验收方：所有结论都附了可复现命令，**不要只看代码推断，跑一遍再判**。

---

## 0. 一句话总结

腾讯 key 当日配额归零（不是"用光"，见 §1）后，地图页真实 POI 改由 **OpenStreetMap** 静态快照提供；同时把早期为演示编造的三个字段（营业时间 / 人均消费 / 景点半径）**全部删除**，景点覆盖范围改用 OSM 的真实多边形。OSM 是 ODbL 协议，页面图例新增了必须显示的数据署名。另外顺手清掉了 `MapCanvas.jsx` 里 3 个既有的 `react-hooks/refs` 报错，现在 `npx eslint app/ lib/ scripts/` **exit 0 无输出**。

---

## 1. 背景：为什么换数据源

`app/api/pois` 的数据来源优先级是：**本地快照 → 腾讯 WebService → mock 示例**。快照不存在时走腾讯，而腾讯这条路当天走不通了。

实测响应头（`GET /ws/place/v1/search`）：

```
2026-10-28 19:07   X-Limit: current_qps=0; limit_qps=5; current_pv=201; limit_pv=200   status=121
2026-10-29 10:55   X-Limit: current_qps=0; limit_qps=0; current_pv=1;   limit_pv=0     status=121
```

关键差别：**`limit_pv` 从 200 变成了 0**。前者是"今日额度用完，等零点重置"，后者是"这个 key 没有可用配额"，等多久都不会恢复，需要去腾讯控制台→配额管理→账户额度 重新分配。所以不能靠等待。

`scripts/snapshot-pois.mjs`（腾讯版抓取脚本）保留未删，配额恢复后可以直接用；它支持断点续抓，且抓不到数据时不会覆盖现有快照。

---

## 2. 改动清单

| # | 文件 | 类型 | 作用 |
|---|---|---|---|
| 1 | `scripts/snapshot-osm.mjs` | 新增 310 行 | 从 Overpass 抓 POI + 景点真实轮廓，生成快照 |
| 2 | `public/data/pois-snapshot.json` | 数据文件（2.64 MB） | 13008 个真实地点，其中 709 个景点带真实多边形（扩到 15000m 后，见 §10） |
| 3 | `lib/pois-service.js` L314–L335 | 改 | `fetchFromSnapshot` 返回 `{ pois, origin }` |
| 4 | `lib/pois-service.js` L347–L354 | 改 | 快照分支把 `origin` 塞进 payload |
| 5 | `app/map/MapView.jsx` L39 | 改 | 新增 `dataOrigin` state |
| 6 | `app/map/MapView.jsx` L72 | 改 | 从响应体读 `data.origin` |
| 7 | `app/map/MapView.jsx` L387–L401 | 改 | 图例里按 `origin` 条件渲染署名 |
| 8 | `README.md` L65–L80 | 新增章节 | 「地点数据从哪来」：两个脚本对比 + 坐标系警告 + 署名要求 |
| 9 | `lib/poi-extras.js` | **删除** | 编造营业时间/人均消费/景点半径的模块，整体移除 |
| 10 | `app/map/MapCanvas.jsx` L124–L172 | 改 | 弹窗只剩真实字段（删掉营业时间/人均/占地三行） |
| 11 | `app/map/MapCanvas.jsx` L98–L110、L263、L408–L418 | 改 | 景点覆盖从「假半径的圆」换成「真实多边形」 |
| 12 | `app/map/MapCanvas.jsx` L188–L207、L223–L231 | 改 | 清掉 3 个既有 eslint 报错：渲染期写 ref 全部挪进 `useEffect`（详见 §4.6） |

`app/api/pois/route.js` **没有改动**：它把 service 返回的 payload 原样 `Response.json()` 出去，新增的 `origin` 字段自动透传。

### 2.1 `scripts/snapshot-osm.mjs`

- ~~一个 Overpass 查询覆盖 6 个分类~~：**2026-10-29 改成每类一次查询**（半径放大后单次太重，6km 时实测 4 次尝试全挂，见 §9）：`amenity`(餐饮/咖啡)、`shop`(超市/商场)、`tourism`+`leisure`(景点/公园)、`highway=bus_stop`、`railway`(车站/地铁口)；
- **必须带 `User-Agent`**：Overpass 会拒绝无 UA 的请求（返回 `406 Not Acceptable`，很容易被误判成"服务挂了"）；
- 坐标 **WGS-84 → GCJ-02**：OSM 是 WGS-84，腾讯地图 GL JS 认 GCJ-02，不转换会整体偏移约 550m。用的是标准 eviltransform 算法（`wgs84ToGcj02`，L60–L108）；
- 过滤：没名字的丢弃（界面会显示"未命名地点"，无意义），超出 3200m 的丢弃；
- 输出 schema 与腾讯版脚本**完全一致**，所以 `lib/pois-service.js` 不需要区分数据来源；
- 失败保护：少于 50 条直接 `exit 1`，不覆盖已有快照。

生成结果（**2026-10-29 扩到 6000m 后的最新一次**，见 §9）：

```
共 2983 个地点 -> public/data/pois-snapshot.json
分类：market=226  restaurant=931  cafe=183  attraction=319  transit=1292  mall=32
按距离（距校园中心）：500m 内 29，1km 内 99，2km 内 394
景点轮廓：190/320 个有真实多边形
跳过：没名字 634，超出半径 233
JSON 约 352 KB
```

（扩展前是 3200m / 923 条 / 187KB / 轮廓 56 个。）

两个容易踩的点，都写进脚本注释了：

- 查询必须用 `out geom` 而不是 `out center`：要画真实轮廓就得拿到节点序列，`out center` 只给一个包围盒中心点；
- **轮廓要对所有分类都算**，不能只算景点：商场、超市、餐厅也常被映射成 `way`（整栋楼），这类实体没有 `lat/lon`，不靠轮廓就取不到坐标、整条会被丢掉 —— 实测会少 50 多条（mall 从 8 掉到 3）。

### 2.2 「只保留真实数据」的两处改动

**弹窗（`MapCanvas.jsx` L133–L172）**：原来有四行，现在两行 + 地址。删掉的三项都是 `lib/poi-extras.js` 用 FNV-1a 哈希从固定候选池里挑的：

| 被删字段 | 原来长什么样 | 为什么必须删 |
|---|---|---|
| `openTime` 营业时间 | 候选池只有 23 种写法，924 条全靠哈希分配 | 与真实商户毫无关系，且每条弹窗都会显示 |
| `avgPrice` 人均消费 | 只有 10 个固定数字：25/32/38/45/52/66/78/95/120/158 | 350 家餐饮全被"定价"，纯属编造 |
| `areaRadius` 景点半径 | 110~199m 随机取一个，用来画圆 | 半径是编的，画出来的范围自然是假的 |

现在弹窗只剩：名称、分类、距离、步行/骑行时间、地址（OSM 有门牌才显示，没有就写"暂无详细地址"）。

**景点占地（`MapCanvas.jsx` L98–L110、L263、L408–L418）**：需求文档要求「景点类用蓝色透明色覆盖其范围」，原来是用编出来的半径画圆。现在换成 `TMap.MultiPolygon` 画 OSM 的真实轮廓（`p.area`，`[lat, lng]` 数组，最多 60 个点）。没有轮廓的 6 个景点就不画 —— 宁可不画，也不编一个范围出来。

`lib/poi-extras.js` 整个文件删除，`lib/pois-service.js` 和 `scripts/snapshot-pois.mjs` 里的 `enrichPoi()` 调用一并去掉（否则腾讯路径还在往数据里加编造字段）。

### 2.3 为什么要在 payload 里加 `origin`

前端原本只能拿到 `x-data-source: snapshot`，这只说明"读的是本地快照"，**无法区分快照是腾讯抓的还是 OSM 抓的**。ODbL 要求：数据来自 OSM 就必须署名，来自腾讯则不需要。所以让 service 把快照自己声明的 `source` 字段（JSON 里的 `"source": "openstreetmap"`）透传到响应体：

```js
// lib/pois-service.js L327
return { pois: [...byId.values()].sort(...), origin: snapshot.source ?? "" };

// lib/pois-service.js L346
return {
  dataSource: "snapshot",
  payload: { ...build(snapshot.pois), origin: snapshot.origin },
};
```

### 2.4 前端署名

```jsx
// app/map/MapView.jsx L387
{dataOrigin === "openstreetmap" && (
  <span className="text-zinc-400">
    地点数据 © <a href="https://www.openstreetmap.org/copyright" ...>OpenStreetMap</a> 贡献者（ODbL）
  </span>
)}
```

渲染在地图下方的图例行末尾（"点击地图上的标记可查看详情"之后）。用条件渲染而不是写死：换成腾讯快照后这行会自动消失，不会出现错误的署名。

---

## 3. 数据链路（验收时可对照）

```
浏览器 /map
  → MapView useEffect: GET /api/pois?lng&lat&radius（300ms 防抖）
  → app/api/pois/route.js GET
      → hasSnapshot() 为真 → cacheKey 带 "snapshot"，跳过 SQLite 缓存
      → loadOnce() → getPois()
          → fetchFromSnapshot(): 读 public/data/pois-snapshot.json，
             按 mtime+size 指纹判断是否需要重读，haversine 现算距离并按 radius 过滤
      → Response.json(payload, { x-cache, x-data-source, x-cost-ms, Cache-Control: no-store })
  → MapView: setPois / setDataSource(响应头) / setDataOrigin(响应体) / setNotice
  → 本地再按分类和 reach 过滤，交给 MapCanvas 画图
```

快照存在时**零网络请求**，也不受腾讯每日额度影响。地图底图仍走腾讯 JS API（`NEXT_PUBLIC_TMAP_KEY`），那是另一套配额，和 POI 搜索无关。

---

## 4. 验证（复现命令 + 期望输出）

前置：`npm run dev`（**必须用 `http://localhost:3000`**，Next 16 的 dev server 会拒绝 `127.0.0.1` 的跨域请求，用 127 会看起来"样式全丢"）。

### 4.1 快照数据本身

```bash
node -e "const s=require('./public/data/pois-snapshot.json'); console.log(s.pois.length, s.source, s.coverRadius, s.capturedAt)"
# 期望：13008 openstreetmap 15000 2026-10-29T08:16:55.xxx
#（2026-10-29 两次扩容：3200→6000→15000，923 → 2983 → 13008 条，见 §9 / §10）

# 快照里不该再有编造字段（三个都应为 0）、应有真实几何（709）
node -e "const s=require('./public/data/pois-snapshot.json');
for (const k of ['openTime','avgPrice','areaRadius']) console.log(k, s.pois.filter(p=>k in p).length);
console.log('area', s.pois.filter(p=>Array.isArray(p.area)).length);"
```

### 4.2 接口走快照、且带 origin

```bash
curl -s -D - -o /tmp/r.json "http://localhost:3000/api/pois?lng=116.3455&lat=39.9862&radius=800" | grep -iE "x-data-source|cache-control"
node -e "const j=require('/tmp/r.json'); console.log(j.pois.length, j.origin, JSON.stringify(j.pois[0]))"
```

期望（实测）：

```
cache-control: no-store
x-data-source: snapshot
58 openstreetmap {"id":"osm:node/4371265938","name":"微薄之盐（Just Kids）","category":"cafe","lng":116.345558,"lat":39.986173,"distance":6}
```

响应里出现的字段应该只有 `id / name / category / lng / lat / distance / address / area`，**没有 `openTime`、`avgPrice`、`areaRadius`**。

四个校门的实测条数（供比对，数值会随半径变化；**以 15000m 这一版为准，见 §10**）：

| 起点 | 800m | 2400m | 4800m | 7500m | 15000m |
|---|---|---|---|---|---|
| 北门 (116.3455, 39.9862) | 57 | 580 | 2032 | 4416 | 12675 |
| 西门 (116.339, 39.981) | 83 | 658 | 2081 | 4437 | 12707 |
| 南门 (116.3465, 39.9758) | 67 | 591 | 2201 | 4636 | 12875 |
| 东三门 (116.3555, 39.9795) | 50 | 530 | 2222 | 4679 | 12886 |

耗时 11~43ms（15000m 时返回 12675 条、约 1.4MB JSON，仍在 50ms 内），`x-cache: miss`（快照模式刻意不走 SQLite 缓存）。

### 4.3 署名确实渲染出来了

打开 `http://localhost:3000/map`，滚到底部图例，最后一项应是「地点数据 © OpenStreetMap 贡献者（ODbL）」，链接指向 `https://www.openstreetmap.org/copyright`。

无头浏览器校验（可选）：

```js
// 在页面上下文执行
({ 有署名: document.body.innerText.includes('OpenStreetMap'),
   链接: document.querySelector('a[href*=openstreetmap]')?.href })
```

实测：`{ 有署名: true, 链接: "https://www.openstreetmap.org/copyright" }`

### 4.4 坐标系是否正确（最关键，别跳过）

WGS-84 当成 GCJ-02 用会整体偏 500 多米，而这种错在缩放级别 15 的地图上**肉眼完全看不出来**，必须放到街道级（18~19 级，比例尺 20 米/10 米）才看得清。

两个判据：

1. 定量：转换函数对天安门已知 WGS 坐标 `(116.391248, 39.906257)` 输出 `(116.397489, 39.907658)`，经度与公开参考值一致（误差 1 米）；
2. 定性：18 级截图里，我们的咖啡标记正好压在腾讯底图自己的「我爱咖啡」标注上。

如果验收时发现标记整体偏向西南（约 500m），说明 `wgs84ToGcj02` 被绕过或写反了。

### 4.5 构建

```bash
npm run build
```

期望：`/api/favorites` 和 `/api/pois` 仍是 **ƒ Dynamic**（两个处理器都 `await connection()`，不能被预渲染）。

实测通过，`✓ Compiled successfully`，两条路由均为 ƒ。

### 4.6 ESLint（本轮已清零）

```bash
npx eslint app/ lib/ scripts/
```

**exit 0，无任何输出。**

在此之前 `app/map/MapCanvas.jsx` 有 3 个 `react-hooks/refs` 报错（"Cannot access refs during render"），位置是**渲染期写 ref**：

```js
// 旧写法（已删除）
poisRef.current = pois;          // 渲染函数体里
modeRef.current = modeId;
centerRef.current = center;
```

改法（`MapCanvas.jsx` L188–L207、L223–L231）：全部挪进 `useEffect`，并用 `useRef(初值)` 提供首帧值。

```js
// 5 个「只绑一次的回调要读最新值」的 ref 合并成一个同步 effect
const poisRef = useRef(pois);
const modeRef = useRef(modeId);
const dataSourceRef = useRef(dataSource);
const favoriteKeysRef = useRef(favoriteKeys);
const onToggleFavoriteRef = useRef(onToggleFavorite);

useEffect(() => {
  poisRef.current = pois;
  modeRef.current = modeId;
  dataSourceRef.current = dataSource;
  favoriteKeysRef.current = favoriteKeys;
  onToggleFavoriteRef.current = onToggleFavorite;
});
```

```js
const centerRef = useRef(center);      // 首帧初值在这里
useEffect(() => {
  centerRef.current = center;          // 后续 center 变了跟上
});
```

两个要点：

1. **effect 按声明顺序执行**，这两个同步 effect 排在下面的初始化 effect（建 `TMap.Map` / `MultiMarker` / `InfoWindow`）之前，所以初始化时 `centerRef.current` 已经是最新值。
2. **读这些 ref 的只有事件回调**（`markers.on("click")`、收藏按钮）**和 `await` 之后的异步代码**，它们的执行时机一定晚于 effect，不存在「首次渲染期间需要读但还没写入」的窗口。

改完做了回归验证，确认 ref 从"渲染期写"挪到"effect 里写"没有破坏事件链路：

| 动作 | 结果 |
| --- | --- |
| 点开一个标记 | `咖啡 · 距离 1.9km · 步行约 24 分钟`，弹窗无营业时间等造假字段 ✓ |
| 点弹窗里的收藏按钮 | `★ 已收藏`，`favorite` 表 +1 ✓ |
| 清理测试数据 | `DELETE` 返回 204，`favorite` 表回到 1 行 ✓ |
| 数据库现状 | `{ id: 647, poi_id: 'p036', source: 'mock-fallback' }` —— 用户真实数据未受影响 ✓ |

---

## 5. 已知限制 / 需要人工确认

1. **腾讯 key 仍不可用**：`limit_pv=0`，需要用户去控制台重新分配额度。代码里腾讯路径完好，配额恢复后删掉 `public/data/pois-snapshot.json`（或跑 `snapshot-pois.mjs` 覆盖）即可切回。注意腾讯脚本现在也不再补营业时间等字段。
2. **OSM 数据质量不等同于商业地图**：部分商户已关闭、部分缺失（校园周边 15km 内取到 13008 条，腾讯通常会更多）；也没有营业时间、人均消费、评分这类字段 —— 这次是**故意没有**，因为拿不到真实值，宁可空着。
3. **景点轮廓只覆盖 709/1057 个**：OSM 里有些景点只有点没有面（viewpoint、小型展馆），这些不画范围。用 `out geom` 抓的轮廓做了抽稀（上限 60 点），形状是近似的真实轮廓，不是精确边界。
4. **署名目前只在地图页图例**：如果将来把 POI 数据导出到别处（导出 CSV、生成图片等），ODbL 要求署名跟着数据走。
5. **快照没有任何 schema 校验**：JSON 被手工改坏时，`loadSnapshot()` 会 `catch` 住返回 null 并回落到腾讯/mock，不会白屏，但也不会报错提示。
6. **旧构建产物里可能残留腾讯 key**：`.env.local` 里 `TENCENT_MAP_KEY` 与 `NEXT_PUBLIC_TMAP_KEY` 目前是**同一个值**，`npm run check:env` 会告警；`.next/static` 里能搜到该 key 的值（按变量名搜不到）。这需要用户申请第二把 key，代码侧只能告警、无法修复。
7. `.data/pois.db.bak` 是历史错误副本（202 行已清掉的 `bulk-*` 数据，不含真实收藏 `p036`），**不要拿它恢复**。

---

## 6. 附：上一轮（2026-10-28 深夜）收藏夹 4 项修复索引

同一次提交里还包含这些，验证方式见各自说明：

| 问题 | 位置 | 验证 |
|---|---|---|
| WAL 下 `cp` 备份是坏的 | `scripts/backup-db.mjs`（新增）、`package.json` `db:backup` | `npm run db:backup` 后用 python/`sqlite3` 打开**备份文件**查 `favorite`，应含 `p036` |
| 服务端 key 被前端复用 | `.env.example`、`README.md` L23–L44、`scripts/check-env.mjs`（新增）、`prebuild` | `npm run check:env`，两值相同时告警（只打印长度） |
| `/api/pois` 缺 `Cache-Control` | `app/api/pois/route.js` L16/L19/L102/L126 | `curl -D -` 看 200 和 400 分支都有 `cache-control: no-store` |
| `checkNumber` 宽松转换 | `app/api/favorites/route.js` L72–L80 | POST `lng:"116.34"` 或 `lng:null` 都应 400 |
| `!source` 静默 return | `app/map/MapView.jsx` L136–L144 | 数据源未就绪时点收藏，面板打开并显示提示 |

---

## 7. 回滚方式

```bash
# 只回滚数据源（保留代码改动）：删掉快照即可回落到腾讯/mock
rm public/data/pois-snapshot.json

# 回滚署名：删掉 MapView.jsx L387–L401 那个条件渲染块，
# 以及 pois-service.js 里 origin 的两处传递（不影响其它逻辑）
```

---

## 8. 追加修复：切换时间 / 出行方式时地图不变

> ⚠ 本节里的条数（503 / 843 等）是当时上限 **3200m** 的实测值。随后又把快照扩到了 **6000m**，最新数字见 **§9**；结论（根因、修法）不变。

**现象**：点「一小时」「骑行」，地图上的点和圈纹丝不动，只有页面底部那行小字变了。

**根因不是渲染，是参数被夹死。** `lib/travel.js` 的 `queryRadius()` 把半径夹在 `[600, 2200]`，六种组合算出来是：

| | 10 分钟 | 半小时 | 一小时 |
|---|---|---|---|
| 步行 4.8km/h | 800m | 2400 → **2200** | 4800 → **2200** |
| 骑行 15km/h | 2500 → **2200** | 7500 → **2200** | 15000 → **2200** |

12 种切换里有 11 种的请求半径**完全相等**，于是

1. 请求 effect 依赖 `[originId, radius]` 不触发 → 不重新取数；
2. 圆画的是 `radius`（2200）→ 圆不动；
3. `visiblePois` 用 `distance <= reach` 过滤，而所有点都在 2200 内、`reach` 全都 ≥2400 → **筛选结果一模一样**。

顺带还有一个"假信息"：那个紫色圆注释写着「这段时间能到的范围」，实际画的是夹断后的 2200m —— 骑行一小时它显示 2.2km。

**改动（3 个文件，不含新增依赖）**

| # | 文件 | 改动 |
|---|---|---|
| 1 | `lib/travel.js` L16–L22 | `MAX_QUERY_RADIUS` 2200 → **3200**，与 `pois-snapshot.json` 的 `coverRadius` 对齐（原来把 3200 那一圈 340 个点全挡在外面了） |
| 2 | `app/map/MapCanvas.jsx` | ① 新增 `reach` prop，紫圈改画**真实可达半径**；② 新增 `fitZoom()`，可达圈变大时视野 `easeTo` 跟随（否则圈跑到画外，等于没变）；③ 可达圈 > 数据圈时补一个灰色数据圈；④ 换出行方式不再关掉弹窗，改成就地重画（"步行约 12 分钟"→"骑行约 4 分钟"） |
| 3 | `app/map/MapView.jsx` | 地图左上角常驻读数「步行 半小时 \| 能到 2.4km · 数据覆盖 2.4km」；可达圈超出数据时，地图底部加一条说明「灰圈外面没有地点数据，不是没画出来」 |

**验证**（dev server + CDP，全部实测）

```
接口层（北门为起点）：
  radius=800   pois=58    最远 791m
  radius=2200  pois=503   最远 2191m
  radius=2400  pois=578   最远 2399m
  radius=2500  pois=602   最远 2497m
  radius=3200  pois=843   最远 3197m     ← 上限放开后新增 340 个点

界面上六个组合，左上角读数逐个不同：
  步行 10 分钟: 能到 800m · 数据覆盖 800m
  骑行 10 分钟: 能到 2.5km · 数据覆盖 2.5km
  步行 半小时: 能到 2.4km · 数据覆盖 2.4km
  骑行 半小时: 能到 7.5km · 数据覆盖 3.2km   ← 出现灰圈 + 说明条
  步行 一小时: 能到 4.8km · 数据覆盖 3.2km
  骑行 一小时: 能到 15.0km · 数据覆盖 3.2km  ← 视野缩到 11 级，紫圈出画但可见弧线

地图上的标记数：578（步行半小时）→ 843（骑行半小时）→ 843（骑行一小时）→ 578（切回）
控制台：无任何报错 / 异常
```

**仍存在的物理限制（不是 bug）**：数据只覆盖 3.2km，「骑行半小时」和「骑行一小时」在数据层面只能是同一批点（都是 3.2km 内的 843 个）。这两者的区别现在靠**紫圈变大 + 视野拉远 + 说明条**表达，而不是假装有数据。要真正撑满 15km，得按更大半径重抓快照（`scripts/snapshot-osm.mjs` 里的 `RADIUS_M`），那是另一次数据更新。

---

## 9. 数据扩容：快照半径 3200m → 6000m（2026-10-29 13:14 完成）

### 9.1 为什么要扩

§8 修完参数之后，虽然每次切换都有可见反馈，但**数据只到 3.2km**，所以「步行一小时（4.8km）」「骑行半小时（7.5km）」能看到的点其实被数据截断了。扩到 6000m 之后：

| 组合 | 理论可达 | 数据覆盖 | 之前（3200m 上限） | 现在 |
|---|---|---|---|---|
| 步行 10 分钟 | 800m | 800m | 58 | 58 |
| 步行 半小时 | 2.4km | 2.4km | 578 | 578 |
| 步行 一小时 | 4.8km | 4.8km | 578（被截到 2.2km，与半小时同） | **2031** |
| 骑行 10 分钟 | 2.5km | 2.5km | 602 | 613 |
| 骑行 半小时 | 7.5km | **6.0km**（到顶） | 843（被截到 3.2km） | **2818** |
| 骑行 一小时 | 15.0km | **6.0km**（到顶） | 843 | **2818** |

（北门为起点。骑行半小时/一小时仍然同数——这不是 bug，是 6km 已经到数据集边界，只能靠灰圈 + 说明条表达。要真覆盖 15km 就是整个市区，Overpass 查不动、前端也画不动。）

### 9.2 脚本必须改成「每类一次查询」，否则必挂

半径放大后，原来「一个查询塞 6 个分类」的写法直接不可用。实测（2026-10-29 12:56~13:00）：

| 尝试 | 结果 |
|---|---|
| 1000m 单分类 | ✅ 200，37s |
| 6000m 全分类 @ overpass-api.de | ❌ TypeError 10.7s / ❌ HTTP 502 2.6s |
| 6000m 全分类 @ kumi.systems | ❌ TypeError 9.0s / ❌ HTTP 504 110.3s |

改成 `CATEGORY_QUERIES` 循环 + 2 个镜像各重试 2 次之后，一次跑通：

```
  餐饮 @ overpass-api.de 第1次：1323 个元素（46.0s）
  商超 @ overpass-api.de 第1次：336 个元素（20.8s）
  景点 @ overpass-api.de 第1次：176 个元素（35.2s）
  公园 @ overpass-api.de 第1次：459 个元素（34.3s）
  公交站 @ overpass-api.de 第1次：1248 个元素（40.2s）
  地铁车站 @ overpass-api.de 第1次：HTTP 502（0.2s）
  地铁车站 @ overpass-api.de 第2次：HTTP 502（0.3s）
  地铁车站 @ overpass.kumi.systems 第1次：HTTP 504（109.9s）
  地铁车站 @ overpass.kumi.systems 第2次：319 个元素（53.4s）
共拿到 3861 个元素（359.8s）
```

**耗时就是 6 分钟**，几乎全在「地铁车站」那一类的 4 次重试上；其余 5 类一次过，合计 176s。所以**周期：顺利 3 分钟，不顺利 6 分钟**，取决于 Overpass 当时负载。

### 9.3 连带改动

| 文件 | 改动 |
|---|---|
| `scripts/snapshot-osm.mjs` | `RADIUS_M` 3200→6000；单查询改成 6 类循环 + `MIRRORS` 重试；任一类失败即整体放弃不写盘 |
| `lib/travel.js` | `MAX_QUERY_RADIUS` 3200→**6000** |
| `app/api/pois/route.js` | 半径上限从写死的 `5000` 改成引用 `MAX_QUERY_RADIUS`（否则前端发 6000 会 400 —— 这就是"上限写两处"的经典坑） |

### 9.4 验证

```bash
# 接口（北门）
radius=800   -> 58    最远 791m
radius=2400  -> 578   最远 2399m
radius=4800  -> 2031  最远 4797m
radius=6000  -> 2818  最远 6000m
radius=6001  -> 400   "radius 必须是 100 到 6000 之间的整数"

# 页面（CDP 实测，每次点完等数据落地再读）
步行 半小时 578     步行 一小时 2031    骑行 10 分钟 613
骑行 半小时 2818    骑行 一小时 2818    步行 10 分钟 58
地图出现(canvas) 405ms，数据到达 874ms，控制台零报错
```

### 9.5 观感优化：标记抽稀 + 远视角改圆点（2026-10-29 13:30 已实现）

骑行半小时/一小时在 15km 视野下原本要画 **2818 个 26×34px 的 pin**，叠成一团色块。做了两件事：

**① 网格抽稀（`MapView.jsx` 的 `markerPois`，上限 `MAX_MARKERS = 1200`）**

- 只作用于标记；**景点轮廓仍然用完整数组画**（否则被抽掉的景点会连蓝色范围一起消失）；
- 规则是**网格**不是等间隔：格子 30m 起、每次 ×1.35，直到总数 ≤1200；同格只留**离起点最近**的那个
  （数据已按 distance 升序，第一个扫到的就是最近的那个）；
- 为什么不用「隔 k 个取一个」：距离有序时那样抽样会抽出一圈圈**同心圆**，看着像人造图案，实测截图确认过。

实测：`步行半小时 578 个 → 不抽稀`；`步行一小时 2031 → 1079`；`骑行半小时/一小时 2818 → 1189`。
概况行会写明「（图上只画了 1189 个，太多会糊成一团）」，不让人误以为数据丢了。

**② 远视角换小圆点（`MapCanvas.jsx`）**

- `zoom <= 12` 时标记用 12×12 的圆点，否则用 pin；
- 靠 `map.on("zoom_changed")` 同步一个 `compact` 布尔值（只在跨越 12 级时 setState，动画期间不会抖），
  geometry 的 `styleId` 在 `cafe` / `cafe:dot` 之间二选一；
- 光抽稀其实不够：1189 个 26px 的 pin 在 15km 视野下仍然互相遮挡，**换成圆点后才看得出疏密**。

**验证**：远/近两种样式下点标记都能正常弹详情（`晨读园 · 景点 · 距离 424m · 步行约 5 分钟`，无造假字段），
控制台零报错；`npx eslint app/ lib/ scripts/` exit 0。

**没做的**：没有按缩放级别动态改抽稀数量（那样要额外监听事件重算几何），也没有做真正的聚合（cluster）。
现在的行为是：远看圆点看疏密，近看 pin 看个体，中间那档（如步行一小时 1079 个）仍然偏密，放大就散开。

---

## 10. 二次扩容：15000m，让「骑行一小时」也有数据（2026-10-29 16:16 完成）

### 10.1 背景

§9 扩到 6km 之后，「骑行半小时（7.5km）」「骑行一小时（15km）」仍然超出数据边界，所以要靠灰圈 + 说明条解释。
当时的取舍是"要么删掉一小时按钮，要么接受这个解释"。**最终选择把数据补到 15km**，按钮保留（`地图界面需求.md` 第 36 行规定了三档时间，删按钮会和作业要求不符）。

### 10.2 怎么抓：4 象限 × 6 分类 = 24 块 + 断点续抓

15km 的 `around` 查询单个必然超时（实测单象限单分类就要 40s+），所以拆成四个矩形分块，最后用 haversine 把矩形角落裁掉。这一轮踩了三个坑，都写进脚本了：

| 坑 | 现象 | 处理 |
|---|---|---|
| **硬超时不生效** | `AbortSignal.timeout(240000)` 下，有一块查询**挂了 7338 秒（2 小时）**才抛 TypeError，整轮任务卡死 | 自己实现 `withHardTimeout()`（`Promise.race` + 定时器），单次 120s |
| **镜像浪费太多时间** | kumi 镜像不响应，每次要等满 120s；而 de 顶不住时是**秒回 502** | 镜像带权重：de 试 3 次、kumi 只试 1 次 |
| **商超/景点整块被拒** | 这两类用正则匹配（`shop~"^(supermarket|…)$"`），密集城区整块查会被网关 502/504；西北块能过、东北/西南同尺寸的块过不了 | 失败块自动**四分**再试（最多两层，最细 3.75km）；已成功的小块落盘 |

另外加了**分块缓存**（`.data/osm-blocks/`）：每块成功即写盘，重跑自动跳过。这条在实战里救了两次 —— 第一次卡死时已经抓完 15 块，重跑只花了 4 分 53 秒（16 块命中缓存，8 块现抓）。

### 10.3 结果

```
共拿到 16827 个元素（293.0s）
共 13008 个地点 → public/data/pois-snapshot.json（磁盘 2.64 MB）
分类：restaurant 3229  transit 7079  attraction 1028  market 786  cafe 729  mall 157
景点轮廓：709/1057 个有真实多边形
跳过：没名字 2396，超出半径 1350
```

### 10.4 连带改动

| 文件 | 改动 |
|---|---|
| `lib/travel.js` | `MAX_QUERY_RADIUS` 6000 → **15000**（正好等于「骑行一小时」的可达距离） |
| `app/api/pois/route.js` | 无改动 —— 上限已经引用 `MAX_QUERY_RADIUS`，自动跟随 |
| `scripts/snapshot-osm.mjs` | `RADIUS_M` 6000→15000；象限切块 + 硬超时 + 分块缓存 + 失败块四分 |

### 10.5 验证

```
接口（北门）：
  radius=2400  →   580 点   11ms
  radius=4800  →  2032 点   14ms
  radius=7500  →  4416 点   29ms
  radius=15000 → 12675 点   43ms（约 1.4MB JSON）
  radius=15001 → 400 "radius 必须是 100 到 15000 之间的整数"

页面（CDP，六组合全点一遍）：
组合            点数     图上抽稀   数据覆盖       灰圈/说明条
步行 半小时      580     不抽稀    2.4km = 可达     无
步行 一小时     2032     1081      4.8km = 可达     无
骑行 10 分钟     614     不抽稀    2.5km = 可达     无
骑行 半小时     4416     1108      7.5km = 可达     无
骑行 一小时    12675      959      15km  = 可达     无

首屏 1232ms，切换约 450ms，控制台零报错。
```

**关键变化**：六个组合的 `reach` 都不再超过 `coverage`，所以**灰圈和那条琥珀色说明条全部消失了** —— 不再需要解释"圈外为什么是空的"。这也是「一小时」按钮可以保留的原因。

### 10.6 明面上的代价

1. **快照 2.64 MB**（磁盘，pretty-print 后的体积；内存字符数 1.5MB）。它只被服务端读取，不让浏览器直接下载，但仓库里多了这么大一个文件；
2. **15km 的接口响应约 1.4MB**：每次切换时间/起点都会重新拉一遍，本机 43ms + 前端解析，实测可接受；换手机流量就会明显；
3. **`.data/osm-blocks/` 里留着 24 个中间文件**（约 10MB），已 gitignore，删掉不影响已生成的快照。

---

## 11. 优化：景区里的小景点折叠进父景区（2026-10-29 16:36 完成）

### 11.1 问题

15km 数据补齐之后，最刺眼的已经不是"点太多"，而是**景区内部的小景点把地图糊死了**。
截图里的颐和园：一个蓝色范围上撒着铜牛、文昌阁、谐趣园、德和园、眺远斋……
远看就是一坨标记，近看才知道是同一个园子里的十几个亭台。

圆明园遗址公园更夸张 —— **79 个**子景点（如园、鉴园、残桥、大水法、海岳开襟……）。

这些子景点在 OSM 里确实是独立实体，但在"我半小时能去哪"这个场景里没有独立存在的意义：
人是一次进园逛一片，不是一个亭子一个亭子打卡。

### 11.2 做法

新增 `scripts/fold-attractions.mjs`，在 `snapshot-osm.mjs` 组装完 `byId`、写盘之前调用一次：

```js
const folded = foldAttractions([...byId.values()]);   // 就地改写 byId
```

判据（**宁可少折，不折错**）：

| # | 规则 | 原因 |
|---|---|---|
| 1 | **只折 `attraction` → `attraction`** | 餐饮/商超/车站绝不能折：它们是真实独立个体，折进商场就再也查不到了 |
| 2 | 父景点必须有真实多边形（`area`），子点用**射线法**判定落在多边形内 | 凹多边形（颐和园的湖岸）不能用外接盒代替 |
| 3 | 多个父景点都包含它时取**最紧的那个**（外接盒面积最小） | 否则"某亭子在颐和园里"可能因为植物园的大轮廓也盖住了它而认错爹 |
| 4 | 子景点外接盒比父景点还大 → 不折 | 这不是包含关系，是数据画重了 |
| 5 | 包含链爬到最外层 | 谐趣园在颐和园里、某个小点在谐趣园里 → 都并到颐和园 |

被折掉的子景点**不是删掉**：名字进父景点的 `contains` 数组（按离父景点中心由近到远排），
弹窗里照样看得到。同名子点（同一地点被映射成"面 + 点"两遍）只删不记，避免出现"颐和园包含颐和园"。

另外顺手做了两件事：

1. **同名裸点去重**：折叠只认"点在面里"，但同一个景点常被映射成"一个面 + 一个点在门口"，
   门口那个点往往正好压在边界上甚至出界十几米，折叠接不住 —— 颐和园本来还剩 1 个面 + 1 个裸点。
   判据：同名 + 点落在面的外接盒（放宽 150m）内 → 删点。共删 3 个。
2. **名称改成中文优先**：`name:zh || name || name:en`。OSM 里 76 条的主 `name` 是英文
   （`Cotti Coffee 库迪咖啡`、`Wagas`、`Exit A1 lift of Zhongguancun Station`），
   中文界面里读起来很跳。`name:zh` 是 OSM 的真实字段，不是编的。
   仍有 25 个子景点在 OSM 里根本没有中文名（`Long corridor`、`Chess Park`、`Stone`），如实保留。

### 11.3 前端

`app/map/MapCanvas.jsx` 的 `buildPopupHtml()` 增加一行（在地址下面、收藏按钮上面）：

```
内含 14 处：昆明湖、景明楼、铜牛、Long corridor、文昌阁、排云殿 …
```

只列前 6 个，完整列表放在 `title` 属性里（鼠标悬停可看）。名字同样过 `esc()` 转义。

### 11.4 验证

```
快照：13008 → 12760 条（折 245，同名去重 3）
分类：attraction 1028 → 780，其余五类不变
折叠规模 Top6：圆明园遗址公园 79、798艺术区 30、国家植物园（南园）18、
               天坛公园 17、颐和园 14、奥林匹克森林公园 12
颐和园：地图上只剩 1 个点（osm:way/29228773，60 顶点轮廓）+ 3 个同名公交站
弹窗：内含 14 处：昆明湖、景明楼、铜牛、Long corridor、文昌阁、排云殿 …
接口：radius=2500 → 614 点（与折叠前一致）；15000 → 12760 点 1.48MB
ESLint：npx eslint app/ lib/ scripts/ → exit 0
```

抽查过的"看起来像误折、其实没错"的几例：

- `西海湿地公园 → 郭守敬纪念馆`、`朝阳公园 → 国际金融博物馆`：博物馆确实在公园范围内，折进去是对的；
- `天坛公园 → 祈年殿 / 圜丘 / 斋宫`：全部真在园内；
- `798艺术区 → 30 个画廊`：798 本来就是一片厂房改的画廊区，合并后地图才像"一个地方"。

### 11.5 代价

- 快照 2.56MB（折叠前 2.64MB，`contains` 数组抵掉了一部分）；
- **收藏夹里已收藏的子景点不受影响**：`favorite` 表存的是名称/分类/坐标快照，不依赖 POI 是否还在列表里；
- 想撤销：把 `snapshot-osm.mjs` 里那三行 `foldAttractions` 调用去掉，重跑脚本即可（24 个分块都在 `.data/osm-blocks/` 缓存里，0.1 秒出结果）。

### 11.6 一个顺手发现但**没改**的小毛病

`POPUP_FONT` 这个常量的值里有双引号（`"Segoe UI"`、`"Microsoft YaHei"`），
而它被塞进 `style="..."` 这个**双引号属性**里 —— 浏览器解析到第二个 `"` 就截断了，
`Segoe UI` 之后的内容变成了无意义属性。视觉上看不出差别（`system-ui` 在 Windows 上就是 Segoe UI），
所以这轮没动。要修就是把常量里的 `"` 换成 `\'`。

---

## 12. 第二轮优化：按《地图界面优化需求.md》做的 8 条（2026-10-29 18:40 完成）

需求原文在 `C:/Users/ASUS/Desktop/地图界面优化需求.md`。这一轮只动前端交互 + 一次数据重抓，接口形状没变。

### 12.1 逐条落点

| # | 需求 | 落在哪 | 实测判据 |
|---|---|---|---|
| 1 | 收藏点定位动画 + 比例尺 400 英尺 : 100 米 | `MapCanvas` 的 `focusPoi` effect | `easeTo` 900ms → 比例尺「100 米」/ zoom 16.0（实测） |
| 2 | 密集处淡出（40px 内 ≥5 个 → 留 1 个） | `computeFaded()` + `paintMarkers()` | 初始视野 12123 个点 → 亮 118 个；放大后逐个恢复 |
| 3 | 交通只留地铁站 / 公交站，弹窗标线 | 数据侧 8 条 Overpass 查询 + `poi.kind` / `poi.lines` | 地铁 273（261 带线路）、公交 6497（6069 带线路），93.5% |
| 4 | 同线路高亮 | `highlightRef` + `${key}:hl` 圆环样式 | 点西土城（10/27 号线）→ 知春里、知春路换成圆环 |
| 5 | 「不显示」模式 | `category === "none"` → 只画 `selectedPoi` | 「不显示模式：图上 0 个节点」；从收藏定位后「1 个」 |
| 6 | 路标（放置 / 拖动 / 点击删除 / 全部删除） | `MapCanvas` 路标层 + 父容器指针事件 | 放置 2 个 → 拖到 (116.3407, 39.9915) → 点一下弹「删除路标」→ 全删归 0 |
| 7 | 路标入库 + 撤销 3 步 + 刷新规则 | `waypoint` 表 + 客户端 `undoRef` | 刷新后「🚩路标 (2)」仍在、撤销按钮 disabled=true |
| 8 | 多用户隔离 | cookie session + `waypoint.session_id` | 另开会话 GET → `{"items":[],"limit":50}`；越权 `PATCH id=999` → 404 |

### 12.2 三个不那么显然的实现选择

**① 交通没有拆 `category` 枚举。** 需求文档自己把「拆成地铁 / 公交两个子类」列成了待定项 ——
`favorite` 表的 `category` 是按 `CATEGORIES` 的 id 校验的，加两个新 id 就得迁移老数据。
所以数据侧仍然是 `category: "transit"`，细分放在 `poi.kind`（`subway` / `bus`），
**筛选条上却真拆成了「地铁」「公交」两个胶囊**（`FILTER_OPTIONS` 里拼进去，`matchesFilter` 认 kind）。
界面上是两个选项、库里仍是一类，收藏表一行不用改。

**② 淡出不是删除。** 被淡掉的点一直在 `MultiMarker` 图层里，只是换了 `styleId`
（`${key}:faded` / `${key}:dotFaded`，`opacity: 0.28`）。判定不成立时换个 styleId 就回来，
所以"放大就恢复"是真的恢复，不是重新加回去。保留哪一个用 **FNV-1a 稳定哈希**按 id 算，
不是 `Math.random()` —— 否则每缩放一次，亮着的那一个就换人，画面会闪。

**③ 撤销栈在内存、路标在库。** 需求 7 把这两件事拆得很清楚：库里的路标刷新后还在，
撤销能力刷新即清空。所以 `undoRef` 就是普通 `useRef` 数组（截断到 3），刻意不做持久化。

### 12.3 数据侧：地铁线路为什么一开始只有 5 个站有

OSM 里 `route=subway` 关系的成员**不是** `railway=station` 节点，而是**站台停靠点**（`role=stop`）。
第一版按 `railway=station` 反查，273 个地铁站只有 5 个能对上线路。改成：

```
relation["route"="subway"](BBOX)->.r;
(.r; node(r.r:"stop"););
```

把停靠点标签一起拉回来，再**按站名对齐**（`normalizeStationName` 去括号、去掉「站 / 车站 / 地铁站」后缀）。
另一个坑：名字索引一开始把公交线路的节点也收了进去，结果「知春路」的弹窗里冒出 386 路、579 路。
拆成 `subwayById`（只收地铁关系节点）之后，地铁 261/273、公交 6069/6497，双向零污染。

耗时：8 条查询 10m56s + 6m52s，分块缓存在 `.data/osm-blocks/`，重跑秒出。

### 12.4 验收里修掉的两个真 bug

1. **从收藏定位过去的交通点，弹窗写成「交通站」、也没有线路行。**
   原因：`focusFavorite` 直接把 `favorite` 表那一行当 POI 用，而收藏表存的是「坐标 + 名字 + 分类」快照，
   存不下 `kind` / `lines`。改成先用 `poi_id` 在已加载的 POI 里找同一个人，合并后再交给弹窗。
   「不显示」模式下这条路径是唯一入口，所以那里最明显（修复前后都截了图）。
2. **页头原本想用 portal 挂到服务端组件的占位里**，触发 `react-hooks/set-state-in-effect`
   （effect 里同步 setState）。改成把页头整行搬进 `MapView`，portal 和挂载点一起删掉。

### 12.5 验证（CDP，脚本留在 `.data/verify*.mjs`）

```
收藏定位：500 米/14.0（初始）→ 100 米/16.0（动画结束）
点标记：  10 米/19.0，弹窗「地铁站 · 距离 1.3km · 步行约 17 分钟 / 途经：10号线、27号线」
同线路高亮：缩到 13.8 后截图，知春里、知春路换成 22px 圆环，其余仍是 pin
不显示：  图上 0 个节点 → 从收藏定位 → 1 个节点；弹窗同样是「地铁站 + 途经」
路标：    2 个 → 拖动落库 → 点一下弹删除 → 删 1 剩 1 → 撤销回 2 → 全删归 0 → 刷新后仍在
隔离：    另开会话 items=[]，越权 PATCH 404
控制台：  异常 0
ESLint：  npx eslint app/ lib/ scripts/ → exit 0
```

### 12.6 已知限制

- 12 个地铁站、428 个公交站查不到线路：OSM 里要么没有对应 `route` 关系，要么站名对不上（如「北京大学东门」vs「北大东门」）。不编数据，弹窗就不显示线路那行。
- 同线路高亮只在**当前已加载的点**里找。切到「10 分钟」后范围缩到 800m，高亮会变成"断断续续"——这是范围变小的事实，不是 bug。
- 「不显示」模式里没法体现同线路高亮（画面上本来就只有一个点），符合需求 5 的字面要求。
- 点弹窗右上角的 × 关掉时不会清高亮（只有点地图空白处才清）—— 小瑕疵，没动。

---

## 13. 第三轮：遮挡 / 路标样式 / 多选筛选 / 只看收藏 / 删收藏（2026-10-29 19:20 完成）

### 13.1 顶部被挡住

原因是两样东西同时在图上方摊开：**放置路标的提示条**是一条 `inset-x-3 top-3` 的通栏紫条，
**路标面板**又贴着右上角开着 —— 两者叠起来把地图上沿整片盖掉。

改法：

- 提示条挪到**底部居中**，改成自适应宽度的小胶囊，并且带一个「停止放置」按钮
  （面板已经收起了，不给出口的话用户没法退出放置模式）；
- 点「放置路标」时**自动收起面板**，进放置模式后屏幕上只剩那个小胶囊；
- 顺带修了一处自相矛盾：原来「不显示」模式下面还挂着「这段时间内没有此类地点」，
  现在只在真的按筛选查过（且结果为空）时才显示。

### 13.2 路标改成红色大图钉，且永不虚化

原来是面 24×30 的小橙旗，用户反馈「不太明显」。现在：

| 项 | 原来 | 现在 |
|---|---|---|
| 形状 | 手绘小旗（和 POI 完全不同形） | 复用 POI 那个 pin 的 path（同一套白描边 + 中心白点） |
| 颜色 | 橙 #f59f00 | **红 #e03131**（和 7 个分类色都不撞） |
| 尺寸 | 24×30 | **36×45**（普通 pin 是 26×34，约 1.4 倍） |
| 描边 | 白色 2px | **深色 #7f1d1d**（同一条 path 画两遍：先带 4.5 宽 stroke，再只填色盖掉内侧半圈） |
| 样式数量 | 1 | 1 —— 没有 `:faded` / `:dot` / `:hl` 变体 |

「永不虚化」不是靠约束，而是结构上就做不到：淡出发生在 `paintMarkers()` 里，它只重设
**普通 POI 图层**的 styleId；路标在独立图层、只认 `waypoint` 这一个样式，密度判定根本扫不到它。
实测缩到 zoom 7（整块华北）时，两枚红图钉依然是清晰的红色 pin，其它点已经糊成一个点。

配套改了两处：

- **命中判定**：原来按「离坐标 18px 内」算，pin 有大半截在坐标上方，点在图钉头上会判不中。
  改成矩形判定（横向 ±20px、纵向从针尖往上 45px、往下留 6px 容错，高度直接读 `WAYPOINT_SIZE`）；
- **气泡位置**：路标气泡的 offset 从 -40 改成 -49，普通 POI 弹窗仍用 -40（新增 `POI_POPUP_OFFSET`，两者互不串）。

商场颜色同时改成紫 `#7c3aed`（原玫红 `#c2255c` 和餐饮的橙挤在同一段暖色里）。

### 13.3 筛选条支持多选

单选 → 多选（`selectedIds` 数组）。语义定死成三条，避免出现自相矛盾的状态：

- 点一个没选的类型 → 加上；再点它一次 → 取消（该类型从图上消失）
- 「全部」= 7 个类型全选（不是"第四种不过滤状态"）
- 「不显示」= 7 个全不选 → 图上只剩「当前打开的那个点」

概况行跟着说实话：`当前范围 249 个地点（已选 3/7 类：餐饮、景点、商场）`。
实测：573 → 去掉餐饮 366 → 再去掉咖啡 301 → 餐饮点回来 509 → 全部 574 → 不显示 0。

### 13.4 从收藏点进去只展示该节点

新增 `solo` 状态（和「不显示」并列，但含义不同：不显示是"一个都不画"，solo 是"只画收藏那一个"）。
点收藏项 → 定位动画 + `setSolo(true)`，其他节点（含景点多边形）全部隐藏；
概况行变成 `只看收藏的「牡丹园」（其他节点已隐藏）`，旁边一个「显示全部地点」按钮。
点任意筛选类型 / 全部 / 不显示都会退出 solo（否则"点了餐饮还是只有一个点"会被当成坏了）。

### 13.5 收藏里加删除

列表每行右侧加「删除」（带边框的小按钮，hover 变红）。
原来整行是一个 `<button>`，里面再塞删除按钮会变成 `<button>` 套 `<button>`（HTML 不允许，浏览器会把内层提到外面），
所以外层改成 `div`，里面两个按钮各管一件事。删掉的正好是当前 solo 的那个点时会一并退出 solo。

### 13.6 顺手修掉的一个坑：放置模式下点哪儿都不放

标记图层和景点多边形都设了 `isStopPropagation: true`（当初是为了"点标记别连带关弹窗"），
结果放置模式下点在标记上或景点范围里时，地图的 `click` 根本收不到，路标放不下去 —— 实测 4 次点击只成功 2 次。

补了两个 handler：放置模式下点标记 → 就地在那个 POI 的坐标放路标；点景点多边形 → 用点击处经纬度放路标。
实测 4 次点击 4 次成功，且全程不弹 POI 弹窗。

### 13.7 验证（CDP，脚本 `.data/verify1{2,3,6,7}.mjs`）

```
多选：      7/7 → 去餐饮 6/7(366) → 去咖啡 5/7(301) → 餐饮回来 6/7(509) → 全部 7/7(574) → 不显示 0
商场色：    筛选条胶囊与图上标记都是 #7c3aed
路标：      36×45 红色 pin + 深色描边；zoom 7 时仍是清晰红图钉，未虚化
放置模式：  面板自动收起、提示在底部、带「停止放置」；点标记/景点 4/4 都能放
收藏定位：  只剩 1 个节点，概况行「只看收藏的「牡丹园」」
收藏删除：  2 → 1，按钮文字同步「我的收藏 (1)」
控制台：    异常 0；ESLint：npx eslint app/ lib/ → exit 0
```

---

## 14. 第四轮：撤销全部删除 / 路标清单 / 预览边框动画（2026-10-29 20:35 完成）

### 14.1 撤销栈改成「一步 = 一组」

原来一次删除压一个坐标，「全部删除」则是**把栈清空**（当时的理由是"撤不完就别让人撤"）。
现在需求反过来：全部删除也必须能撤。

改法：`undoRef` 从 `[item, item, ...]` 变成 `[[item], [item,item,item], ...]` ——
一层是「一步」，一层是「这一步删掉的若干路标」。单删压 `[1 个]`，全删压 `[当时所有 N 个]`，
`撤销删除` 弹一层、把里面每一条按原顺序重建（POST 回去，标签沿用原值）。
栈深度仍是需求的 3 步，只是每一步现在可以还原"一批"。实测：3 个路标 → 全部删除 → 0 →
撤销 → 3（一步全回来了）。

### 14.2 路标窗口变成真正的清单

和「我的收藏」对齐，`🚩 路标` 面板里现在有：

| 区域 | 内容 |
|---|---|
| 说明 | 放置/拖动/点删除的用法 |
| 放置路标 | 进放置模式（面板自动收起，底部小胶囊提示 + 「停止放置」） |
| 只显示全部路标（N） | 进「路标预览」：只画 N 个路标，其他节点全隐藏，视野撑到装下它们 |
| 清单 | 每条一行：`🚩 路标 1 / 116.34350, 39.98550` + 右侧「删除」；点行本身进单点预览 |
| 撤销 / 全部删除 | 见 14.1 |

收藏面板同步加了「只显示全部收藏（N）」。

### 14.3 预览：四种范围 + 一圈淡蓝色边框

新增一个状态（取代上一轮的 `solo` 布尔量，因为范围不止一种）：

```js
preview = null
       | { kind: "poi", poi }        // 只画这一个地点
       | { kind: "waypoint", wp }    // 只画这一个路标
       | { kind: "favorites" }       // 只画全部收藏
       | { kind: "waypoints" }       // 只画全部路标
```

`canvasPois` / `canvasHidden` / `canvasWaypoints` 三个派生值把这些翻译成地图要的东西：
「只看路标」时给空点集（POI 全不画）、「只看一个地点」时走 `hidden + selectedPoi` 那条老路。

**进场动画**（按需求原话实现）：

1. 被点的窗口先量一个矩形（`[data-preview-source]` 上的 `getBoundingClientRect`），
   立刻渲染一个 `position: fixed` 的淡蓝色框（`border-2 border-sky-300/90`）盖在那个位置；
2. 30ms 后把框的 `left/top/width/height` 改成地图容器的矩形 —— 四个属性一起过渡 460ms，
   视觉上就是"窗口退化成边框、飞过去贴住地图四边"；
3. 520ms 时框内顶部中央出现小标签`特定节点展示 ×`（`pointer-events` 只开在标签上，别的地方不吃点击）。

   **边框的三次调参**（都是"看着不够"逼出来的）：

   | 版本 | 边框 | 缘由 |
   |---|---|---|
   | 初版 | `border-2` + `sky-300/90` | 淡，浅色底图上几乎看不见 |
   | 二改 | `3px` + `sky-600/85` + 标签 15px 加粗 | 用户「加粗加深、字要大」 |
   | 三改 | `6px` + `sky-600/80` + `inset 0 0 0 2px rgba(7,89,133,.92)` | 用户「再粗一倍，最内侧继续加深」 |

   三改的"最内侧更深"用 `box-shadow: inset` 做，而不是再套一层 div：
   `border` 画在外沿、`inset shadow` 贴着内沿，两圈颜色一深一浅叠出实体感，
   一个元素搞定，四角圆角天然对齐。`box-shadow` 也纳入 transition（300ms），
   所以标签出现时那圈浅蓝外发光是渐变出来的，不是闪一下。

   **框的 z-index 压到 `1900`**（窗口是 2000 / 2100）：放到 3000 时框会横穿两个窗口、
   把窗口的圆角和阴影切掉一半，用户原话「这个边框把窗口遮住了很难看」。
   现在窗口浮在框上面，框只露在地图这块区域，像是"地图自己长出来的边"。
   标签本身在框内部、`top-2` 居中，不受窗口影响。

**预览中再点节点：不重播动画，也不收窗口**

用户原话：「当已经处于特定节点展示状态时再次点击两个窗口中的节点不用再出现蓝色边框生成动画了，
边框就放在地图边缘不用动」。

`openPreview` 开头判断 `frame?.label`（框已经贴好且标签已出现）：

```js
setPreview(next);
if (frame?.label) return;   // 只换数据，后面的量矩形 / setFrame / 定时器全部跳过
setFavOpen(false);
setWpOpen(false);
...
```

两个容易忽略的配套：

- **窗口要留着别关**。第一版把 `setFavOpen(false)/setWpOpen(false)` 写在 return 之前，
  结果每点一次窗口就收起来，用户想连点第二个节点得重新点开 —— 那"再次点击"这个需求本身就废了。
  现在两行挪到 return 之后：**首次进入预览收窗口（要看地图），已在预览中则窗口常开、只换框里的内容**。
- **依赖数组带上 `frame`**（`[clearFrameTimers, frame]`）。`frame` 是 state，回调里读到的是闭包快照，
  不带进依赖就永远拿到初始的 `null`，`frame?.label` 恒假 → 每次点击照旧飞一遍。

**退场**（三改后的三段接力，用户要求"蓝雾向四边散去、框内逐渐变亮"）：

| 时刻 | 动作 |
|---|---|
| 0ms | 雾气开始往外散（`scale 1 → 1.18` + `blur 0 → 10px` + 淡出，620ms）；数据同时恢复、筛选回全选、地图 `easeTo` 回初始视野 |
| 180ms | 边框才开始淡（380ms）—— 错开这一步，否则"雾还在散、框先没了"，像画面被裁掉一块 |
| 760ms | 整块从 DOM 摘掉 |

雾气散开的 620ms 正好盖住地图缩回去的 700ms —— **"亮起来"的过程就是"雾退了"**，
不需要再单独做一个提亮动画。

两个不显然的点：

- **框是 fixed 的，页面一滚就会和地图脱开** —— 加了 scroll/resize 监听，跟着地图重新贴一次，
  且这一步要关掉过渡（`animate: false`），否则每个滚动事件都播一遍 460ms 动画，边框像橡皮筋。
- **点筛选 / 删掉正在预览的那个东西** 时要退出预览，但不能播退场动画（用户是主动放弃，不是点 ×）：
  另写了一个 `dropPreview()`（直接 `frame = null`），`toggleFilter / selectAllFilters / clearFilters`、
  `deleteWaypoint`、`removeFavorite` 都走它。

### 14.4 验证（CDP，脚本 `.data/verify2{1,2,4}.mjs`、`.data/verify3{1,2}.mjs`）

```
全部删除撤销：3 → 0 →（撤销删除 1）→ 3
路标清单：    面板里列出「路标 1/2/3」，点一行 → 「只看路标「路标 1」」+ 边框 + zoom 16
边框贴合：    落定后框的矩形 32,144,1366,576 == 地图容器矩形（逐像素相等）
飞行途中：    截图可见一个淡蓝小框正从右上角面板的位置往地图方向长大
退出（×）：   框消失、zoom 16 → 14.0、「当前范围 574 个地点（已选 7/7 类）」
只显示全部收藏：「只看全部收藏 3 个点」，图上只剩 3 个蓝色地铁站标记
只显示全部路标：「只看全部路标 2 个点」，图上只剩 2 枚红图钉
交叉情况：    预览中点「餐饮」→ 框立即收起、筛选生效（6/7 类）；删掉被预览的路标 → 预览自动退出
控制台异常 0；ESLint → exit 0
```

三改（边框加粗 / 不遮挡窗口 / 二次点击不重播）的实测（`verify31.mjs` + `verify32.mjs`）：

```
预览 1： 「只看收藏的「知春路」」  框 32,144,1366,576  z=1900  bw=6px
开窗口： 窗口 z=2000（框在下）、框矩形不变 → 截图确认窗口完整、圆角不再被切
点第 2 个（牡丹园）：120ms 框 32,144,1366,576；520ms 框 32,144,1366,576（没动）→ 文案换成「只看收藏的「牡丹园」」
点第 3 个（西土城）：面板 open w=272 h=233 始终在开 → 文案换成「只看收藏的「西土城」」
控制台异常 0；ESLint（app/ lib/）→ exit 0
```

一次点击的完整判定口径：**框的矩形在 120ms 和 520ms 两个采样点必须一模一样**。
如果重播了生成动画，120ms 时框还在从窗口飞过来的半路上，数值必然不同 —— 这个判据比截图更硬。

### 14.5 四改：框内蓝雾、退场散雾、点 pin 也能聚焦

用户原话：「边框落定后加一点极淡的蓝雾（bg-sky-500/5）把地图框内整体压暗一点点，
视觉上更像"聚焦"；退出该模式的时候要有恢复动画，蓝雾向四边散去，框内逐渐变亮。
另外我想让我放进去的节点点击后也能有聚焦动画。」

**一、蓝雾用两层 div，不是一层**

```
框（fixed, border 6px）
└── 裁剪层  absolute inset-0 overflow-hidden  borderRadius 12
    └── 雾层  absolute inset-0  radial-gradient + transform/opacity/filter 过渡
```

外层只干一件事：`overflow-hidden`。散场时雾层 `scale(1.18)`，如果不裁，它会盖到地图外面
（框外面变成一圈蓝），裁住之后就是"雾被推出画面四边"。

内层背景是 `radial-gradient` 而不是纯色 `rgba(56,189,248,.05)`：
纯色铺满是"整张图均匀蒙一层"，看着像屏幕脏了；径向渐变是**中心 3.5%、贴边 13%**，
中间那些标记基本不受影响、四角自然暗下去 —— 这才是镜头聚焦的感觉。

半径写 `115% 115% at 50% 46%`：圆心略微上移（46% 而不是 50%），
因为地图可视区下沿压着筛选条，视觉重心本来就偏上一点，正圆的暗角会显得"下边太重"。

**二、散场的三个属性一起动**

```js
opacity:   fogOut ? 0 : (label ? 1 : 0),      // 450ms
transform: fogOut ? "scale(1.18)" : "scale(1)",  // 620ms
filter:    fogOut ? "blur(10px)"  : "blur(0px)", // 620ms
```

`fogOut` 是 `frame` 上的一个布尔量，`exitPreview` 一置位三个属性同时开始过渡。
**不能**用 `label: false` 当退场条件：退场时标签是立刻摘掉的（否则那个 × 还能点第二下），
标签一没雾就跟着瞬间消失，`scale`/`blur` 根本没机会播。

`frame.label === false` 那段（还在飞的时候）雾的 opacity 是 0，
所以雾是"框落定、标签出现"那一刻淡入的，和标签同步。

**三、点地图上的 pin 也要有聚焦动画**

窗口里点一行 → 传的是 DOM 元素，量 `getBoundingClientRect` 就行。
地图上的 pin 是画在 canvas 里的，没有 DOM 可量 —— 所以 `openPreview` 的第二个参数
现在**同时接受元素和裸矩形**：

```js
const origin = srcEl && typeof srcEl.getBoundingClientRect === "function"
  ? (srcEl.closest?.("[data-preview-source]") ?? srcEl) : null;
const from = origin?.getBoundingClientRect?.() ?? (srcEl && typeof srcEl.left === "number" ? srcEl : to);
```

矩形由 MapCanvas 算：只有它持有 map 实例，能 `projectToContainer(latLng)`：

```js
const p = map.projectToContainer(new TMap.LatLng(wp.lat, wp.lng));
const r = el.getBoundingClientRect();
onFocusWaypointRef.current?.(wp, {
  left: r.left + p.x - WAYPOINT_SIZE.width / 2,
  top:  r.top  + p.y - WAYPOINT_SIZE.height,
  width: WAYPOINT_SIZE.width, height: WAYPOINT_SIZE.height,
});
```

于是动画起点正好是那枚 36×45 的图钉本身 —— 框从 pin 身上长出来，再飞向地图四边。
`onFocusWaypoint` 走 ref 转发，因为这个回调绑在只执行一次的拖动 effect 里。

**点 pin 同时还有"要删除这个路标吗？"的气泡**（这是上一轮的需求，不能丢）。
两个一起出现不冲突，但**退出预览时气泡必须自己收掉** —— 用户点 × 走了，
图上还挂着一条没人管的确认框。判定不能用"路标列表变了"：退出时列表从 `[这一个]`
变回 `[全部]`，那个路标仍然在里面，数据上看不出差别。所以给 MapCanvas 加了
`previewing` 这个布尔量，专门盯 `true → false` 那一下。

**四、ESC 退出**

标签上那个 × 只有 24px，键盘党不想为此去找鼠标。`frame.label` 为真时才挂 keydown，
正在飞的 500ms 里不接管 —— 那时候按 ESC 大概率是手滑。

**验证（`.data/verify33.mjs`，全程 CDP）**

```
点 pin（扫到 706,420 命中）  → 框 32,144,1366,576 bw=6px，「只看路标「路标 1」」，雾 op=0.64（还在淡入）
退出 60ms  → 框 op=1.00（边框还没开始淡） | 雾 op=0.83 scale=1.048 blur=1.57px
退出 260ms → 框 op=0.69                 | 雾 op=0.35 scale=1.146 blur=5.95px
退出 ~700ms→ 框已摘除、雾已摘除、地图恢复「范围 574 个地点」
ESC        → 标签消失、框摘除、气泡收掉
控制台异常 0；ESLint（app/ lib/）exit 0
```

「点 pin」这一条没用写死的坐标：地图在放置路标那一步做过一次 `easeTo`，
整幅图会平移十几像素，写死坐标必然扑空（第一版就是这么失败的）。
改成在预期位置周围扫 7 个候选点，谁命中算谁 —— 顺带把命中矩形也验了。

### 14.6 路标改名（2026-10-29 第五轮）

规则：**`PATCH /api/waypoints` 一个动词两种载荷** —— 带 `lng/lat` 是移动（原有），
只带 `label` 是改名（新增），两样都没有就 400。

```js
patch({ id, lng, lat })   // 拖动落库
patch({ id, label })      // 改名，label 为 null 表示回到默认「路标 N」
```

不开 `/api/waypoints/rename` 子路由：都是"改这一条路标的某个字段"，
前端只记一个地址更省事。db 层也刻意分成 `moveWaypoint` / `renameWaypoint` 两个函数，
不合成一个 `updateWaypoint(patch)` —— 合成的版本很容易出现
「只想改名，却因为 `lng` 是 undefined 把坐标写成 NULL」。

**交互是行内编辑**，不用 `window.prompt`（它会把地图冻住，移动端还长得像报错）：

点 ✎ → 名字那一行换成输入框（`autoFocus`，最多 40 字）→ 下面那行坐标变成「回车保存 · Esc 取消」
→ 输入框右侧的按钮从 `✎ 删除` 换成 `✓ ✕`。

保存路径有三条：**回车 / ✓ / 失焦**。取消有两条：**Esc / ✕**。
清空后回车 → 回到默认名「路标 N」（`waypointsRef` 里的下标 + 1），
不留空白行 —— 列表里有一行没名字根本没法点。

三个容易写错的地方：

1. **「提交」会重复触发**。回车之后输入框被卸载，焦点回退本身还可能再补一个 blur；
   点 ✓ 也是「先 blur 再 click」。用一个 ref 挡：
   ```js
   if (renameBusyRef.current) return;
   renameBusyRef.current = true;
   ```
   复位只在 `startRename` 里做（下次打开才清），不能靠 `setTimeout` ——
   那是在和"blur 比卸载晚一帧"的时序赌运气。
2. **点 ✕ 会变成保存**。按下鼠标的那一刻输入框先失焦（onBlur = 保存），
   click 才轮到「取消」，于是"点了叉，名字却存下来了"。
   两个按钮都得 `onMouseDown={(e) => e.preventDefault()}`，
   不让焦点在点击之前离开输入框。
   注意：用 `element.click()` 测这个 bug 测不出来 —— 合成 click 压根没有 mousedown，
   必须用 CDP 的 `Input.dispatchMouseEvent` 真点。
3. **改名的值写在 `renaming`（state）里，但 `commitRename` 的依赖是空数组**，
   直接读 state 会拿到首帧的 `null`。另设 `renamingRef` 在 effect 里同步，
   和这个文件里其他"只绑一次的回调"是同一套做法。

名字生效的地方不止列表：地图 pin 的删除气泡标题、概况行的「只看路标「X」」、
`MultiMarker` 的 `properties.title` 都读 `wp.label`，改完一处全跟着变。

**验证（`.data/verify34.mjs`，全部以接口里的 label 为准）**

```
初始           74:路标 1  75:路标 2
回车保存       74:图书馆  75:路标 2
Esc 取消       74:图书馆  75:路标 2   （没被改掉）
失焦保存       74:东门    75:路标 2
点 ✕ 取消      74:东门    75:路标 2   （不是"点叉应该放弃"，mousedown 拦截生效）
清空后回车     74:路标 1  75:路标 2
改成「图书馆门口」并刷新页面 → 74:图书馆门口  75:路标 2
控制台异常 0；ESLint（app/ lib/）exit 0
```

## 15. 打卡（2026-10-29 第六轮）

需求：「点进某个标志（包括自己放的）弹出的窗口下面有打卡选项，可以进行勾选。
勾选以后标志中间那个白色的圆形镂空变成明亮的黄色填充。右上角我的收藏下方设置我的打卡，
界面和操作关系和我的收藏差不多，有删除、重命名、点进去也能进入特定节点展示。
特别注意如果先后打开收藏和打卡他们窗口的遮挡关系。」

### 15.1 数据：一张表 + 一条「伪 source」

`checkin` 表基本照抄 `favorite`，只多两件事：

| 列 | 用途 |
|---|---|
| `label` | 面板里改的名字。`name` 是上游快照，**不改** —— 改了下次从弹窗看就对不上了 |
| `source`/`poi_id` | 路标打卡用 `source='waypoint'`、`poi_id='wp:<路标id>'` |

伪 source 的好处：一张表、一个列表、一次预览就能把「POI 打卡」和「路标打卡」混着显示，
不用两套表两套接口。代价是 `category` 会出现一个 `"waypoint"`，它不在 `CATEGORIES` 里 ——
所以校验时单独把它加进白名单，而不是去污染 `CATEGORIES`（那边一动，底部 7 个筛选类型全跟着变）。

接口 `app/api/checkins/route.js`：GET / POST（幂等，`UNIQUE + ON CONFLICT DO NOTHING`）/
PATCH（改名）/ DELETE。DELETE 有两种入口：

```
DELETE ?id=12                  面板列表里删一行
DELETE ?poi_id=xxx&source=yyy  弹窗里再点一次「已打卡」取消
```

### 15.2 打卡图案：黄描边 + 4 根黄反斜线

（15.2 初版是"中间那个洞变黄"，用户看完说「打卡成功后的图案改一下：边框从白色改成黄色，
内部打上 4 根等距较粗黄色反斜线」，现已按此重做。）

`pinSrc(color, checked)` 的打卡版本由三层组成，**底色不动**：

```svg
<clipPath id="pinClip"><path d="钉身" transform="translate(13 13) scale(0.86) translate(-13 -13)"/></clipPath>
<path d="钉身" fill="分类色" stroke="#ffd400" stroke-width="2"/>          <!-- ① 黄描边 -->
<g clip-path="url(#pinClip)" stroke="#ffd400" stroke-width="2.6">       <!-- ③ 黄斜纹 -->
  <line x1="-k" y1="0" x2="34-k" y2="34"/>   k = -12 / -4 / 4 / 12
</g>
```

底色保留是因为颜色在这张地图上有含义（橙餐饮 / 紫商场 / 深蓝地铁），整根换掉就抹了分类。

四个不显然的点：

- **斜纹必须 clip**。不裁的话会画到图钉外面 —— 满屏的标记会变成一堆互相穿插的黄条。
- **裁剪路径要往里缩 14%**（`scale(0.86)`）。不缩的话斜纹正好顶到描边上，
  黄描边 + 黄斜纹连成一片，用户就**看不出"有边框"这回事**了。缩一圈留一条底色缝，
  才能同时看见「黄边框 / 底色 / 黄斜纹」三层。
- **斜线用 `y = x + k` 直接算端点**，`x1=-k, y1=0, x2=h-k, y2=h`，故意超出视口交给 clip 裁。
  相邻 k 差 8 → 垂直间距 8/√2 ≈ 5.7px，线宽 2.6 → 缝约 3.1px；k 取 ±4 / ±12 是
  为了让斜纹在钉头圆心上**对称**（奇数条才谈得上"正中一条"，4 条只能左右各两条）。
- **方向容易搞反**：`y = x + k` 是 y 变大时 x 也变大，`y` 向下 → 线从左上走向右下 → 反斜线 `\`。
  光看渲染图容易看错（我第一次就以为自己画成了 `/`），最后是用 canvas 读回截图、
  对比上下两行黄带中心的 x 才确认的（`Δx = +49` → 确实是 `\`）。

配套三处：

- `dotSrc(color, true)`：缩到圆点级别（zoom ≤ 12）时 12px 里根本分辨不出 4 根斜线，
  所以只保留"边框变黄"这一个特征：色点 + 黄描边。
- 每个配色键多两个样式 `${key}:checked` / `${key}:dotChecked`，共 7×2 = 14 个。
- `paintMarkers` 里 **checked 的优先级高于 faded**：自己标记过的地方被密集判定淡掉，
  这个功能就白做了。代价是密集区里打卡点会略"跳"，这是有意的。
- 路标图层单独一个 `waypointChecked` 样式：描边从深红换成黄，同样 4 根斜纹（k = ±5 / ±15，
  线宽 3.2），白色圆点去掉 —— 有斜纹之后中心再放个圆点只会糊成一团。

### 15.3 弹窗里那颗按钮

两段 HTML 都是运行时拼的字符串，靠 `data-*` 把「是谁」带出去，
由 document 上的事件委托接住（`data-check-poi` / `data-check-wp`），
和 `data-fav-poi`、`data-wp-del` 同一套机制。**必须 `event.stopPropagation()`**，
否则 TMap 认为"点了地图空白"，弹窗会立刻被关掉。

按钮文案跟着状态走：`○ 打卡` ↔ `✓ 已打卡`（黄底 `#fff8dc` / 黄边 `#e0b400`）。

刷新有两条路，都要管：

- POI 弹窗：`useEffect(..., [ready, favoriteKeys, checkinKeys, dataSource])` 里 `setContent(renderPopup(poi))`。
- **路标气泡**不在 `openPoiRef` 那套里（它是"删除确认"，不是 POI 弹窗），
  所以打卡状态一变要单独 `setContent(waypointDeleteHtml(wp, {checked}))`。
  漏了这一步的表现是：点了打卡，按钮还写着「○ 打卡」，用户以为没生效。

### 15.4 「我的打卡」面板与遮挡关系

按钮排在「我的收藏」正下方（右上角一列），面板贴在地图右上角 `z-[2000]`，
和收藏面板**同一个位置**。

所以两个面板做了**互斥**：开一个就关掉另一个。

```js
onClick={() => { setFavOpen((o) => !o); setCheckinOpen(false); }}   // 收藏
onClick={() => { setCheckinOpen((o) => !o); setFavOpen(false); }}   // 打卡
```

这不是"调 z-index 让后开的盖住先开的"能解决的：两个面板宽高几乎一样、锚点完全重合，
叠在一起时下面那个只会露出一条边，看起来像渲染错位。互斥之后没有"遮挡"这回事 ——
任意时刻右上角最多只有一个浮层。路标面板在按钮行的左侧、锚点不同，不受影响。

面板内容照抄收藏：标题 + 「只显示全部打卡（N）」+ 列表（`✎` 改名 / `删除`）+ 错误行。
列表行的第二行在改过名之后会把原名带出来（`· 原名 XXX`），否则"这到底是哪儿"就认不出来了。

改名复用路标那套行内编辑：回车 / ✓ / 失焦保存，Esc / ✕ 取消，`onMouseDown preventDefault`，
`renameCheckinBusyRef` 防重复提交。清空 = `label: null` = 回到上游原名
（路标改名是回到「路标 N」，两者语义不同，别抄错）。

### 15.5 预览：两个新 kind

```js
{ kind: "checkin",  item }   // 只看这一条打卡
{ kind: "checkins" }         // 只看全部打卡
```

难点是打卡可能打在两种东西上，得分开喂给两个图层：

```js
checkinPois      // source !== "waypoint" → 普通 POI 图层
checkinWaypoints // source === "waypoint" → 路标图层（红色大 pin）
```

路标那批不能当 POI 画：`styleKeyOf` 拿 `category = "waypoint"` 去 `STYLE_KEYS` 里查不到配色。
反过来也不能塞进路标图层当坐标 —— 那批是**真实的 waypoint 对象**，所以「只看全部打卡」时
它们还能拖动、还能点开气泡，行为一致。

**这两个 memo 必须排在 `canvasPois` 之前**：`useMemo` 的依赖数组在**渲染期**求值，
写在后面就是 `ReferenceError: Cannot access 'checkinPois' before initialization`。
（同理，`checkinWaypoints` 用到 `waypoints` state，也不能排到它前面。）

已知取舍：删掉一个路标，它的打卡记录会留下（列表里还能看、能删、能改名，只是点不进去、
图上也不画）。做级联删除要在 `DELETE /api/waypoints` 里多删一次 `checkin` ——
没做，因为删路标本身是可撤销的，级联删打卡就得连打卡一起进撤销栈，代价比收益大。

### 15.6 验证（`.data/verify3{5,6}.mjs`）

```
弹窗      点标记 → 弹窗底部出现「☆ 收藏 ○ 打卡」两个按钮并排
勾选      点「○ 打卡」→ 接口里出现 1 条、按钮变「✓ 已打卡」、右上角计数变 (1)
图案      放大 12 倍截图：黄描边 + 4 根等距反斜线，条纹不溢出轮廓（.data/verify37.mjs）
方向      用 canvas 把截图读回来，比上下两行黄带中心的 x：Δx=+49 → 是反斜线 \ 不是 /
面板互斥  只开收藏 → 面板=我的收藏；开打卡 → 面板=我的打卡，收藏面板已关闭（false）
          再开收藏 → 面板=我的收藏，打卡面板已关闭（false）
改名      ✎ → 输入「自习教室」→ 回车 → 接口 label = 自习教室
预览      点该行 → 「只看打卡的「自习教室」（其他节点已隐藏）」+ 边框 32,184,1366,576
          退出后文案清空、框摘除
删除      删除 → 接口 0 条、计数 (0)
路标打卡  点自己放的 pin → 气泡「○ 打卡 / 删除路标」→ 点打卡 → waypoint:wp:79，
          气泡按钮就地变「✓ 已打卡」，红色路标图钉也换成黄描边 + 黄斜纹
混合预览  一条 POI + 一条路标 → 「只显示全部打卡（2）」→ 图上正好两个点，中心都是黄的
控制台异常 0；ESLint（app/ lib/）exit 0
```

一处顺带的变化：页头右上角从"一个按钮"变成"两个按钮一列"，地图容器整体下移了 40px，
所以预览边框的 top 从 144 变成了 184 —— 这个数字是量出来的，不是写死的。

### 15.7 收藏 / 打卡的「全部删除 + 撤销」（2026-10-29 第七轮）

用户原话：「给收藏和打卡安排全部删除和撤销操作，具体细节和路标一样」。
"一样"拆成四条可执行的：**一步 = 一组、深度 3、只在前端内存里、撤销靠重建而不是恢复 id**。
三个面板（路标 / 收藏 / 打卡）现在是同一套代码形状，样式也是同一串 class。

数据侧只多了两个函数，接口只多了一个分支：

```js
// lib/db.js
export function removeAllFavorites(sessionId)   // DELETE FROM favorite WHERE session_id = ?
export function removeAllCheckins(sessionId)    // DELETE FROM checkin  WHERE session_id = ?

// app/api/{favorites,checkins}/route.js 的 DELETE
if (searchParams.get("all") === "1") { ... }     // 和 /api/waypoints 同一个口径
```

前端两个栈，互不相干（删收藏不该让打卡的撤销按钮亮起来）：

```js
const favUndoRef = useRef([]);       const [favUndoDepth, setFavUndoDepth] = useState(0);
const checkinUndoRef = useRef([]);   const [checkinUndoDepth, setCheckinUndoDepth] = useState(0);
```

为什么栈里存的是**快照**而不是 id：原行已经从库里删了，`id` 是 `AUTOINCREMENT`，不能复用。
撤销 = 拿快照重新 POST 一条，服务端按 `UNIQUE(...) + ON CONFLICT DO NOTHING` 幂等处理，
所以「连点两下撤销」「撤销时另一标签页刚收藏过同一个点」都不会造出重复行。

**"全部删除"本身也是一步**（不是一个"清空栈"的动作）——这一点最容易写错：

```js
pushFavUndo(before);          // 把删掉的那一整批压进栈
setFavorites([]);
fetch("/api/favorites?all=1", { method: "DELETE" });
```

撤销一批时有个小坑：列表是 `created_at DESC`（新的在上），如果按列表原顺序（新的先建）逐条
POST，重建出来的时间戳顺序会翻过来，恢复后三条的顺序和删除前相反。所以**按倒序重建**：

```js
for (const item of [...step].reverse()) { ... POST ...; setFavorites(prev => [data.item, ...prev]); }
```

单条撤销就没办法了：重建的那条时间戳变新，会回到列表最上面。这和路标面板的行为一致
（那边列表是 `created_at ASC`，撤销的那条落到最下面），属于"重新创建"语义的自然结果，
服务端和客户端看到的顺序也是同一个，刷新不会变。

撤销失败要把这一步**还回栈**，否则用户点一下就把机会弄丢了：

```js
catch (e) {
  favUndoRef.current = [...favUndoRef.current, step].slice(-UNDO_DEPTH);
  setFavUndoDepth(favUndoRef.current.length);
  setFavError(e?.message || "撤销失败");
}
```

顺带收拾的两处：
- 「全部删除」把正在预览的那个点也删了 → 顺手 `dropPreview()`，不然框里一个点都没有。
  收藏这边还要判断"预览的这一点是不是来自收藏"（从搜索结果点进去的预览不该被清空打断）。
- 面板底部一行小字说明"撤销最多 3 步，刷新后失效"，因为这是纯前端内存，用户看不见就得写出来。

验证见 `.data/verify38.mjs`（截图 `hh1`~`hh10`）：

```
造数据    接口造 3 收藏（丙乙甲）+ 2 打卡（自习教室 / 打卡一），刷新后界面一致
单删      删「收藏乙」→ 列表 丙甲、按钮变「撤销删除（1）」
撤销      点一下 → 列表 乙丙甲（乙回到最上面，符合"重新创建"）、按钮回到「撤销删除」
全部删除  列表空、标题 (0)、「全部删除」变灰、「还没有收藏」提示出来、库里 0 条
撤销全部  三条一起回来、顺序丙乙甲不掉、库里三条
深度封顶  连删 3 条 → 按钮「撤销删除（3）」（栈是 `slice(-3)`，再多也只留最近 3 步）
撤销 ×3   三条都回来，按钮回到「撤销删除」
打卡同构  同样走一遍；撤销重建后 label 还在（库里是 `自习教室:打卡二`、`—:打卡一`）
面板互斥  开打卡时收藏面板 = false
刷新      数据还在，两个「撤销删除」都回到 disabled（栈是内存里的）
控制台异常 0；ESLint（app/ lib/）exit 0
```

## 16. 上云：数据在哪儿、怎么保证"下次进来还在"（2026-10-29 晚）

用户问的是"部署到服务器后，别人用过留下的收藏/打卡，下次重新打开网站还在不在"。
答案取决于两件**同时**成立的事，所以先改掉了两个会让人误判"数据丢了"的点。

### 16.1 数据在哪

全在一个 SQLite 文件里，默认 `<项目>/.data/pois.db`（WAL 模式，另有 `-wal` / `-shm`）。
四张表：`favorite` / `waypoint` / `checkin` 三张用户数据 + `poi_cache`（腾讯结果缓存，与用户无关）。
"谁的数据"靠 cookie `sid`（HttpOnly、SameSite=Lax、180 天），三张表都有 `session_id` 列。
**没有账号体系**，所以"一个用户" = 一个浏览器；换浏览器/清 cookie 就看不到自己的列表了。

### 16.2 改动一：`Secure` 改为跟着请求协议走（`lib/session.js`）

原来：

```js
if (process.env.NODE_ENV === "production") parts.push("Secure");
```

`npm run start` 下 NODE_ENV 就是 production，若用户用 `http://<IP>:3000` 访问，
浏览器会**直接丢掉**带 Secure 的 Set-Cookie → 每次刷新都是新 session →
表现成"我收藏了，下次进来又空了"（数据在库里，只是每条都认不出主人）。
这是上云第一天就会踩的坑。

现在按协议判断，反代也能正确识别：

```js
const proto = request.headers.get("x-forwarded-proto");   // Nginx 终结 TLS 时唯一可靠的信源
if (proto) return proto.split(",")[0].trim().toLowerCase() === "https";
return request.nextUrl?.protocol === "https:";
```

线上还跑裸 http 时会在**一个进程内只警告一次**（`[session] 线上用的是 http…`），不刷日志。

### 16.3 改动二：`POI_DB_PATH`（`lib/db.js`）

```js
export const DB_PATH = process.env.POI_DB_PATH
  ? resolve(process.cwd(), process.env.POI_DB_PATH)
  : resolve(process.cwd(), ".data", "pois.db");
```

三个理由（都是会咬人的）：
1. `.data/` 在 `.gitignore` 里 → 重新 `git clone` / `rsync --delete` 覆盖，库跟着没，
   第一次请求会静默建一个**空库**；
2. 路径相对 `process.cwd()` → pm2/systemd 的 `cwd` 没指对，就在别处新建空库，
   旧数据还在老目录，界面上却什么都看不到；
3. 库放数据盘（`/var/lib/poi-map/pois.db`），备份、迁机器、扩盘都不用动代码。

`getDb()` 里加了一行**只打一次**的日志：`[db] 数据库：<绝对路径>（来自 POI_DB_PATH）`。
上面第 2 种情况排查就看这行 —— 比翻代码猜快得多。

`scripts/backup-db.mjs` 改成 `import { DB_PATH } from "../lib/db.js"`，不再自己拼 `.data`：
不然线上把库挪走后，备份会去备一个不存在（或更糟，一个空的旧库）。
`npm run db:backup` 里补了 `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`
（package.json 没有 `"type": "module"`，Node 24 会为此打一行性能警告，纯噪音）。

### 16.4 验证

```
cookie    curl 直连 http：    sid=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000        （无 Secure）
          curl 带 x-forwarded-proto: https：… Max-Age=15552000; Secure                        （有 Secure）
会话      curl -c/-b 同一 cookie：POST 建一条 → GET 读回同一条 → DELETE 后列表回空
POI_DB_PATH=/tmp/.../pois.db
          打印「[db] 数据库：…（来自 POI_DB_PATH）」，查询 0 条，目录里真的生成了 pois.db（53KB）
备份      npm run db:backup → 警告有 4032KB 的 -wal → 备份 112KB、favorite 34 行（WAL 里的写入没丢）
ESLint    app/ lib/ scripts/ → exit 0
```

### 16.5 仍然存在（靠代码解决不了，只能靠运维/产品）

| 场景 | 结果 | 说明 |
|---|---|---|
| 关浏览器、重启服务、重启机器 | 数据在 | 数据在服务器文件里，不在浏览器 |
| `git pull` + `npm ci`（不动 `.data`） | 数据在 | 只要不删目录 |
| `rsync --delete` / 换目录重新 clone | 丢 | `.data` 被 gitignore → 新目录自动建空库（已用 `POI_DB_PATH` 规避） |
| Docker 重新 build、没挂 volume | 丢 | 容器销毁文件跟着没 |
| 换服务器 / 重装系统 | 丢 | 靠 `db:backup` + 异地存一份 |
| 用户清 cookie / 换浏览器 / 换设备 | 他的列表空 | 匿名 session 的固有代价，要根治只能加登录 |
| 从 `http://IP:3000` 换到 `https://域名` | 同上 | cookie 按域名隔离，等于换人 |

线上部署的参数（pm2 示例，`cwd` 必须指项目根）：

```
cwd: /var/www/poi-map          # 若用 POI_DB_PATH 指到数据盘，这一项不再影响数据位置
env: { NODE_ENV: production, POI_DB_PATH: /var/lib/poi-map/pois.db }
```

再加一条 crontab 做备份（备份也要落到数据盘/OSS，别只留在项目目录）：

```
0 3 * * * cd /var/www/poi-map && POI_DB_PATH=/var/lib/poi-map/pois.db npm run db:backup
```
