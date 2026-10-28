"use client";

// 唯一持有状态的组件：数据、分类、半径、loading 都在这里。

import { useEffect, useMemo, useState } from "react";
import FilterBar from "./FilterBar";
import MapCanvas from "./MapCanvas";

// 中心点固定（本阶段不支持拖动改中心）。
// 换成真接口后 center 仍由后端原样回传，这里只是请求参数。
const DEFAULT_CENTER = { lng: 116.348, lat: 39.981 };

export default function MapView() {
  const [pois, setPois] = useState([]);
  const [category, setCategory] = useState("all");
  const [radius, setRadius] = useState(2000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const center = DEFAULT_CENTER;

  // 半径变了就重新请求接口（分类不参与请求，切分类不发网络）
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError("");
      try {
        const url = `/api/pois?lng=${center.lng}&lat=${center.lat}&radius=${radius}`;
        const res = await fetch(url, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error?.message || `HTTP ${res.status}`);
        }
        setPois(data.pois ?? []);
      } catch (e) {
        // 切半径时上一个请求会被 abort，这不是错误
        if (e?.name !== "AbortError") setError(e?.message || "请求失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    load();
    return () => controller.abort();
  }, [radius]);

  // 分类过滤仍在本地做；distance 再兜一层，防止上游返回圈外的点
  const visiblePois = useMemo(
    () =>
      pois.filter(
        (p) => (category === "all" || p.category === category) && p.distance <= radius,
      ),
    [pois, category, radius],
  );

  const noResult = !loading && !error && visiblePois.length === 0;

  return (
    <div>
      <FilterBar
        category={category}
        radius={radius}
        onCategoryChange={setCategory}
        onRadiusChange={setRadius}
      />

      {/* 容器高度写在这里，地图组件只负责填满。
          地图要一直挂着：切半径时不能卸载重挂，否则等于重建地图、视野会丢 */}
      <div className="relative h-[68vh] min-h-[420px] w-full overflow-hidden rounded-[18px] bg-zinc-100">
        <MapCanvas center={center} radius={radius} pois={visiblePois} />

        {loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/40">
            <p className="rounded-full bg-white/90 px-4 py-1.5 text-sm text-zinc-600 shadow-sm">
              加载中…
            </p>
          </div>
        )}

        {error && !loading && (
          <div className="absolute inset-x-3 top-3 rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700 shadow">
            接口请求失败：{error}
            <span className="ml-2 text-xs text-red-500">（点一下别的半径可以重试）</span>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-zinc-600">
        <span>
          当前显示 <b className="text-zinc-900">{visiblePois.length}</b> 个地点
          <span className="ml-2 text-xs text-zinc-400">
            （半径 {radius >= 1000 ? `${radius / 1000}km` : `${radius}m`} 内）
          </span>
        </span>
        {noResult && <span className="text-amber-700">该范围内暂无此类地点</span>}
      </div>

      {!process.env.NEXT_PUBLIC_TMAP_KEY && !process.env.NEXT_PUBLIC_TMAP_PROXY_HOST && (
        <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
          浏览器端还没配 <code className="font-mono">NEXT_PUBLIC_TMAP_KEY</code>
          ，底图会是空白的。这个是给浏览器加载地图 SDK 用的公开 key，和服务端
          <code className="mx-1 font-mono">TENCENT_MAP_KEY</code> 不是同一个用途。
        </p>
      )}
    </div>
  );
}
