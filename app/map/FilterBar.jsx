"use client";

// 受控组件：自己不存任何状态，选中的值全靠 props 传进来、点击只往上回调。
// 这样「当前选了什么」只存在 MapView 一处，不会出现两份状态对不上。

import { ALL_CATEGORY, CATEGORIES, RADIUS_OPTIONS } from "./categories";

function chipClass(selected) {
  return [
    "rounded-full border px-4 py-1.5 text-sm transition-colors",
    selected
      ? "border-zinc-800 text-white"
      : "border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400",
  ].join(" ");
}

export default function FilterBar({
  category,
  radius,
  onCategoryChange,
  onRadiusChange,
  disabled = false,
}) {
  const chips = [ALL_CATEGORY, ...CATEGORIES];

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3">
      {/* 分类筛选 */}
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((c) => {
          const selected = category === c.id;
          return (
            <button
              key={c.id}
              type="button"
              disabled={disabled}
              onClick={() => onCategoryChange(c.id)}
              className={chipClass(selected)}
              // 选中色由 categories.js 提供，Tailwind 无法生成动态色值，所以走内联 style
              style={selected ? { backgroundColor: c.color, borderColor: c.color } : undefined}
            >
              {/* 未选中时用一个小色点提示分类颜色，选中时反白 */}
              <span
                className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                style={{ backgroundColor: selected ? "#ffffff" : c.color }}
                aria-hidden="true"
              />
              {c.label}
            </button>
          );
        })}
      </div>

      {/* 半径切换 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400">半径</span>
        {RADIUS_OPTIONS.map((r) => {
          const selected = radius === r;
          return (
            <button
              key={r}
              type="button"
              disabled={disabled}
              onClick={() => onRadiusChange(r)}
              className={[
                "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                selected
                  ? "border-[#726fab] bg-[#726fab] text-white"
                  : "border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400",
                disabled ? "cursor-not-allowed opacity-50" : "",
              ].join(" ")}
            >
              {r >= 1000 ? `${r / 1000}km` : `${r}m`}
            </button>
          );
        })}
      </div>
    </div>
  );
}
