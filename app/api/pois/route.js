// GET /api/pois?lng=&lat=&radius=
// 返回形状与 public/mock/pois.json 完全一致，前端只需要换 URL。

import { getPois, PoisError } from "@/lib/pois-service";
import { logRequest, makeCacheKey, readCache, writeCache } from "@/lib/db";

// SQLite 驱动是原生模块，必须跑在 Node.js 运行时。
// 这里**不能**写 export const runtime = "nodejs"：
// 本项目 next.config.mjs 开了 cacheComponents，而它明确禁止声明 runtime 段配置
// （报错：Route segment config "runtime" is not compatible with `nextConfig.cacheComponents`）。
// 不写时的默认运行时本来就是 nodejs，所以删掉等价，且能过构建。

function fail(httpStatus, code, message) {
  return Response.json({ error: { code, message } }, { status: httpStatus });
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
  if (!Number.isInteger(radius) || radius < 100 || radius > 5000) {
    return { error: fail(400, "INVALID_PARAM", "radius 必须是 100 到 5000 之间的整数") };
  }

  return { lng, lat, radius };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const parsed = parseParams(searchParams);
  if (parsed.error) return parsed.error;

  const { lng, lat, radius } = parsed;
  const startedAt = Date.now();
  const cacheKey = makeCacheKey(lng, lat, radius);

  try {
    // 1. 先查缓存
    const cached = readCache(cacheKey);
    if (cached) {
      const costMs = Date.now() - startedAt;
      logRequest({ lng, lat, radius, hit: true, costMs });
      console.log(`[pois] cache=hit key=${cacheKey} cost=${costMs}ms`);
      return Response.json(cached.payload, {
        headers: {
          "x-cache": "hit",
          "x-data-source": "cache",
          "x-cost-ms": String(costMs),
        },
      });
    }

    // 2. 没命中就取数据（有 key 走腾讯，没 key 走 mock）
    const { payload, dataSource } = await getPois({ lng, lat, radius });

    // 3. 写缓存 + 记日志
    writeCache(cacheKey, payload);
    const costMs = Date.now() - startedAt;
    logRequest({ lng, lat, radius, hit: false, costMs });
    console.log(
      `[pois] cache=miss source=${dataSource} key=${cacheKey} count=${payload.pois.length} cost=${costMs}ms`,
    );

    return Response.json(payload, {
      headers: {
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
