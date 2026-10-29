// GET /api/pois?lng=&lat=&radius=
// 返回形状与 public/mock/pois.json 完全一致，前端只需要换 URL。

import { getPois, hasSnapshot, PoisError } from "@/lib/pois-service";
import { logRequest, makeCacheKey, readCache, writeCache } from "@/lib/db";
// 半径上限只认这一处定义（lib/travel.js），前端切换时间时算出来的值也走同一个常量。
// 之前这里是写死的 5000，前端上限改到 6000 之后请求直接 400，白查一轮。
import { MAX_QUERY_RADIUS } from "@/lib/travel";

// SQLite 驱动是原生模块，必须跑在 Node.js 运行时。
// 这里**不能**写 export const runtime = "nodejs"：
// 本项目 next.config.mjs 开了 cacheComponents，而它明确禁止声明 runtime 段配置
// （报错：Route segment config "runtime" is not compatible with `nextConfig.cacheComponents`）。
// 不写时的默认运行时本来就是 nodejs，所以删掉等价，且能过构建。

// 响应一律 ban 掉 HTTP 缓存，和 /api/favorites 口径保持一致。
// 不加的后果：浏览器/中间代理可能把某一次 2200m 的结果留下来，用户切换起点后
// 拿到的还是旧坐标那一份点；前端靠 x-data-source 决定收藏的 source，读错还会串数据。
const NO_STORE = { "Cache-Control": "no-store" };

function fail(httpStatus, code, message) {
  return Response.json({ error: { code, message } }, { status: httpStatus, headers: NO_STORE });
}

// 同一组参数的请求在飞的时候，后来的请求直接等它的结果，不再重复打上游。
// 触发场景很常见：页面刷新、React 19 StrictMode 把 effect 跑两遍、用户连点按钮。
// 每一次重复都是 30 次以上的上游调用，这是最容易被忽略的浪费。
const inFlight = new Map();

function loadOnce(cacheKey, args) {
  const running = inFlight.get(cacheKey);
  if (running) return running;

  const task = (async () => {
    const result = await getPois(args);
    // 只缓存真正来自上游的数据：
    //   - 快照本来就在本地文件里，再存一份没意义（而且改了 JSON 希望立即生效）
    //   - 降级的示例数据更不能缓存，否则会占住这个位置 7 天
    if (result.dataSource === "tencent") {
      writeCache(cacheKey, result.payload);
    }
    return result;
  })();

  inFlight.set(cacheKey, task);
  // 用 then(clear, clear) 而不是 finally：finally 会把拒绝吞成新 promise，
  // 上层就拿不到原始错误了
  const clear = () => inFlight.delete(cacheKey);
  task.then(clear, clear);

  return task;
}

function parseParams(searchParams) {
  const lngRaw = searchParams.get("lng");
  const latRaw = searchParams.get("lat");
  const radiusRaw = searchParams.get("radius");

  if (lngRaw === null || latRaw === null || radiusRaw === null) {
    return { error: fail(400, "INVALID_PARAM", "lng、lat、radius 三个参数都必须传") };
  }

  const lng = Number(lngRaw);
  const lat = Number(latRaw);
  const radius = Number(radiusRaw);

  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { error: fail(400, "INVALID_PARAM", "lng 必须是 -180 到 180 之间的数字") };
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { error: fail(400, "INVALID_PARAM", "lat 必须是 -90 到 90 之间的数字") };
  }
  if (!Number.isInteger(radius) || radius < 100 || radius > MAX_QUERY_RADIUS) {
    return {
      error: fail(400, "INVALID_PARAM", `radius 必须是 100 到 ${MAX_QUERY_RADIUS} 之间的整数`),
    };
  }

  return { lng, lat, radius };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const parsed = parseParams(searchParams);
  if (parsed.error) return parsed.error;

  const { lng, lat, radius } = parsed;
  const startedAt = Date.now();

  // 数据源也进 key：快照 / 腾讯 / mock 是完全不同的点集，共用缓存会串味
  const source = hasSnapshot()
    ? "snapshot"
    : process.env.TENCENT_MAP_KEY
      ? "tencent"
      : "mock";
  const cacheKey = makeCacheKey(lng, lat, radius, source);

  try {
    // 1. 先查缓存（快照模式跳过：数据在本地文件里，算一次只要几毫秒）
    const cached = source === "snapshot" ? null : readCache(cacheKey);
    if (cached) {
      const costMs = Date.now() - startedAt;
      logRequest({ lng, lat, radius, hit: true, costMs });
      console.log(`[pois] cache=hit key=${cacheKey} cost=${costMs}ms`);
      return Response.json(cached.payload, {
        headers: {
          ...NO_STORE,
          "x-cache": "hit",
          // 这里必须给真实数据源，不能给 "cache"：
          // 命中缓存的点仍然是 tencent（或 mock）的点，前端拿这个值当收藏的 source，
          // 一旦第二次访问变成 "cache"，收藏就会记到另一个 source 名下、看起来"丢了"。
          // 命中与否已经由 x-cache 表达，一个头管一件事。
          "x-data-source": source,
          "x-cost-ms": String(costMs),
        },
      });
    }

    // 2. 没命中就取数据（有 key 走腾讯，没 key 走 mock，上游挂了降级到 mock）
    const { payload, dataSource, notice } = await loadOnce(cacheKey, { lng, lat, radius });

    // 3. 记日志（缓存是 loadOnce 里写的，多个并发请求只会写一次）
    const costMs = Date.now() - startedAt;
    logRequest({ lng, lat, radius, hit: false, costMs });
    console.log(
      `[pois] cache=miss source=${dataSource} key=${cacheKey} count=${payload.pois.length} cost=${costMs}ms`,
    );

    return Response.json(notice ? { ...payload, notice } : payload, {
      headers: {
        ...NO_STORE,
        "x-cache": "miss",
        "x-data-source": dataSource,
        "x-cost-ms": String(costMs),
      },
    });
  } catch (error) {
    const costMs = Date.now() - startedAt;

    if (error instanceof PoisError) {
      // 上游的原始错误码只落服务端日志，不给前端
      console.error(`[pois] ${error.code} ${error.detail} cost=${costMs}ms`);
      logRequest({ lng, lat, radius, hit: false, costMs });
      return fail(error.httpStatus, error.code, error.message);
    }

    console.error("[pois] 未预期错误", error);
    logRequest({ lng, lat, radius, hit: false, costMs });
    return fail(500, "INTERNAL_ERROR", "服务端内部错误，请查看服务端日志");
  }
}
