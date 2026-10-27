"use client";

// 唯一持有状态的组件：数据、分类、半径、loading 都在这里。
// 数据一改，下面靠 props 自动跟着变 —— 不要去手工改 DOM。

import { useEffect, useMemo, useState } from "react";
import FilterBar from "./FilterBar";
import MapCanvas from "./MapCanvas";

// 走 fetch 而不是 import：第三阶段把这个 URL 换成 /api/pois，其余代码一行不用动
const DATA_URL = "/mock/pois.json";

export default function MapView() {
  const [pois, setPois] = useState([]);
  const [center, setCenter] = useState(null);
  const [category, setCategory] = useState("all");
  const [radius, setRadius] = useState(2000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(DATA_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setPois(data.pois ?? []);
        setCenter(data.center ?? null);
        if (data.radius) setRadius(data.radius);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // 分类 + 半径两个条件都在这里过滤完再交给地图，MapCanvas 只管画
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
        disabled={loading}
      />

      {/* 容器高度写在这里，地图组件只负责填满 */}
      <div className="relative h-[68vh] min-h-[420px] w-full overflow-hidden rounded-[18px] bg-zinc-100">
        {loading && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-zinc-500">数据加载中…</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="text-sm text-red-600">数据加载失败：{error}</p>
          </div>
        )}

        {!loading && !error && center && (
          <MapCanvas center={center} radius={radius} pois={visiblePois} />
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
          还没配 key，底图会是空白的（腾讯会提示「当前产品鉴权失败」）。去腾讯位置服务官网申请
          key，写进项目根目录 <code className="font-mono">.env.local</code>：
          <code className="ml-1 font-mono">NEXT_PUBLIC_TMAP_KEY=你的key</code>
          ，保存后重启 dev server。
        </p>
      )}
    </div>
  );
}
