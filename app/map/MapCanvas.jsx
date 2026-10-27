"use client";

// 只负责「画图」：接收 props → 初始化一次地图 → props 变了就调 setGeometries 更新图层。
// 不取数据、不存筛选状态，那些都在 MapView 里。

import { useEffect, useRef, useState } from "react";
import { CATEGORIES } from "./categories";

// SDK 地址：有 key 时追加 &key=xxx；没有 key 时原样请求（走代理模式）。
const SDK_SRC = "https://map.qq.com/api/gljs?v=1.exp";

// 两个可选的环境变量（写在项目根目录 .env.local，改完要重启 dev server）：
//   NEXT_PUBLIC_TMAP_KEY        腾讯位置服务申请的 key —— 推荐用法
//   NEXT_PUBLIC_TMAP_PROXY_HOST 代理免 key 模式的转发地址
// 代理模式的任务书占位形式（原样保留，未替换成真实地址前不要启用）：
//   http://127.0.0.1:__WB_HTTP_PORT__/_TMapService/_wbt/__WB_TMAP_SECRET__
const API_KEY = process.env.NEXT_PUBLIC_TMAP_KEY;
const PROXY_HOST = process.env.NEXT_PUBLIC_TMAP_PROXY_HOST;

// 模块级单例：React 19 开发模式 StrictMode 会把 effect 跑两遍，
// 不做幂等就会插两个 <script>，第二个覆盖第一个，地图直接白掉。
let sdkPromise = null;

function loadTMapSdk() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.TMap) return Promise.resolve();
  if (sdkPromise) return sdkPromise;

  // 代理免 key 模式：必须在插 script 之前设好
  if (PROXY_HOST && !window._TMapSecurityConfig) {
    window._TMapSecurityConfig = { serviceHost: PROXY_HOST };
  }

  const src = API_KEY ? `${SDK_SRC}&key=${encodeURIComponent(API_KEY)}` : SDK_SRC;

  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      if (window.TMap) resolve();
      else reject(new Error("SDK 下载成功，但没有挂上 window.TMap"));
    };
    script.onerror = () => reject(new Error(`腾讯地图 SDK 下载失败：${src}`));
    document.head.appendChild(script);
  });

  return sdkPromise;
}

// 图标是内联 SVG 转 data URI，按颜色缓存，避免反复拼字符串
const pinCache = new Map();

function pinSrc(color) {
  if (pinCache.has(color)) return pinCache.get(color);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">
  <path d="M13 1C6.3 1 1 6.3 1 13c0 8.8 12 20 12 20s12-11.2 12-20C25 6.3 19.7 1 13 1Z" fill="${color}" stroke="#ffffff" stroke-width="2"/>
  <circle cx="13" cy="13" r="4.5" fill="#ffffff"/>
</svg>`;
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  pinCache.set(color, src);
  return src;
}

// 每个分类一种样式（颜色来自 categories.js，这里不写字面量）
function buildMarkerStyles(TMap) {
  const styles = {};
  for (const c of CATEGORIES) {
    styles[c.id] = new TMap.MarkerStyle({
      width: 26,
      height: 34,
      anchor: { x: 13, y: 34 }, // 底部尖角对准坐标点
      src: pinSrc(c.color),
    });
  }
  return styles;
}

function buildCircleStyles(TMap) {
  return {
    radius: new TMap.CircleStyle({
      color: "rgba(114, 111, 171, 0.10)", // 半透明填充
      showBorder: true,
      borderColor: "#726fab",
      borderWidth: 2,
      borderDashArray: [8, 6], // 虚线描边
    }),
  };
}

export default function MapCanvas({ center, radius, pois }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const circlesRef = useRef(null);

  // 初始化只跑一次，但 center 是异步取回来的；用 ref 取「最新值」，
  // 就不用把 center 写进初始化 effect 的依赖里（写了会导致重建地图）
  const centerRef = useRef(center);
  centerRef.current = center;

  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        await loadTMapSdk();
        if (cancelled || !containerRef.current || !window.TMap) return;
        // 已经有实例就绝不再建：重建会闪烁、丢缩放、泄漏
        if (mapRef.current) return;

        const TMap = window.TMap;

        const map = new TMap.Map(containerRef.current, {
          center: new TMap.LatLng(centerRef.current.lat, centerRef.current.lng),
          zoom: 15,
          // 不传 mapStyleId、不调用 TMap.setConfig()：只用官方默认样式
        });
        mapRef.current = map;

        // 图层只建一次，之后靠 setGeometries 换内容（不要每帧 new 图层）
        markersRef.current = new TMap.MultiMarker({
          map,
          styles: buildMarkerStyles(TMap),
          geometries: [],
        });
        circlesRef.current = new TMap.MultiCircle({
          map,
          styles: buildCircleStyles(TMap),
          geometries: [],
        });

        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    }

    init();

    return () => {
      cancelled = true;
      // 卸载时销毁，避免切页面泄漏 WebGL 上下文和 DOM
      try {
        markersRef.current?.setMap(null);
        circlesRef.current?.setMap(null);
        mapRef.current?.destroy();
      } catch {
        // 销毁失败不影响页面切换
      }
      markersRef.current = null;
      circlesRef.current = null;
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // 数据 / 筛选变了只更新图层，绝不碰地图实例
  useEffect(() => {
    if (!ready || !window.TMap) return;
    const TMap = window.TMap;

    // 每次都给全新的 geometry 数组：传同一个引用，SDK 不认为有变化
    markersRef.current?.setGeometries(
      pois.map((p) => ({
        id: p.id,
        styleId: p.category,
        position: new TMap.LatLng(p.lat, p.lng),
        properties: { title: p.name, address: p.address },
      })),
    );

    // MultiCircle 的 center 必须是 TMap.LatLng，radius 必须是数字（不能是字符串）
    circlesRef.current?.setGeometries([
      {
        id: "radius",
        styleId: "radius",
        center: new TMap.LatLng(center.lat, center.lng),
        radius: Number(radius),
      },
    ]);
  }, [ready, pois, radius, center]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
          <p className="max-w-xl text-sm leading-6 text-red-600">地图加载失败：{error}</p>
        </div>
      )}
    </div>
  );
}
