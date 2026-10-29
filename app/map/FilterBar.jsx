"use client";

// 受控组件：自己不存任何状态，选中的值全靠 props 传进来、点击只往上回调。
// 这样「当前选了什么」只存在 MapView 一处，不会出现两份状态对不上。
//
// 需求 5 的句式：「我想要在 #1 时间内 #2 至较近的 #3」
// 这三个空做成胶囊按钮，直接嵌在句子里，读起来就是一整句话。

import { FILTER_OPTIONS, FILTER_TYPE_IDS } from "@/lib/categories";
import { TIME_OPTIONS, TRAVEL_MODES } from "@/lib/travel";

// 「不显示」不是分类，是显示模式（需求 5）：选中后地图上除当前打开的那个点以外，
// 什么都不画。所以它单独一个 id，和分类选项并列放在同一行末尾。
const NONE_OPTION = { id: "none", label: "不显示" };

function chipClass(selected, disabled) {
  return [
    "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1 text-[15px] leading-6 transition-colors",
    selected
      ? "border-[#726fab] bg-[#726fab] text-white"
      : "border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400",
    disabled ? "cursor-not-allowed opacity-50" : "",
  ].join(" ");
}

/**
 * 2026-10-29：分类从单选改成**多选**。
 *
 *   - 点一个没选中的类型 → 加上它
 *   - 再点一次已选中的类型 → 取消这个类型（它就从图上消失）
 *   - 「全部」= 7 个类型全选（不是"不过滤"这个第四种状态，避免出现「全部 + 餐饮」这种自相矛盾的组合）
 *   - 「不显示」= 7 个全不选 → 图上只剩「当前打开的那个点」
 *
 * 所以这里不存状态，只把「哪些 id 现在选着」传出去；选中/取消由上层算。
 */
export default function FilterBar({
  selectedIds,
  timeId,
  modeId,
  onToggle,
  onSelectAll,
  onClear,
  onTimeChange,
  onModeChange,
  disabled = false,
}) {
  const selected = new Set(selectedIds);
  const allSelected = selected.size === FILTER_TYPE_IDS.length;
  const noneSelected = selected.size === 0;
  const chips = [...FILTER_OPTIONS, NONE_OPTION];

  return (
    <section className="rounded-[18px] border border-zinc-200 bg-white/90 px-5 py-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-[15px] leading-8 text-zinc-700">
        <span>我想要在</span>
        {TIME_OPTIONS.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={disabled}
            onClick={() => onTimeChange(t.id)}
            className={chipClass(timeId === t.id, disabled)}
          >
            {t.label}
          </button>
        ))}
        <span className="mx-0.5">时间内</span>

        {TRAVEL_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={disabled}
            onClick={() => onModeChange(m.id)}
            className={chipClass(modeId === m.id, disabled)}
          >
            {m.label}
          </button>
        ))}
        <span className="mx-0.5">至较近的</span>

        {/* 分类有 8 个，放不进同一行，单独占一行接着读。
            可多选之后给一句提示，否则「点了两个都亮着」容易被当成卡了。 */}
        <span className="mt-1 flex w-full flex-wrap items-center gap-2">
          {chips.map((c) => {
            const isAll = c.id === "all";
            const isNone = c.id === "none";
            const on = isAll ? allSelected : isNone ? noneSelected : selected.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (isAll) onSelectAll();
                  else if (isNone) onClear();
                  else onToggle(c.id);
                }}
                className={
                  isNone
                    ? [
                        "inline-flex items-center gap-1.5 rounded-full border border-dashed px-3.5 py-1 text-[15px] leading-6 transition-colors",
                        on
                          ? "border-transparent bg-zinc-600 text-white"
                          : "border-zinc-300 text-zinc-500 hover:border-zinc-400",
                        disabled ? "cursor-not-allowed opacity-50" : "",
                      ].join(" ")
                    : chipClass(on, disabled)
                }
                // 选中色由 categories.js 提供，Tailwind 无法生成动态色值，所以走内联 style
                style={on && !isNone ? { backgroundColor: c.color, borderColor: c.color } : undefined}
                aria-pressed={on}
              >
                {/* 未选中时用一个小色点提示分类颜色，选中时反白 */}
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: on ? "#ffffff" : c.color }}
                  aria-hidden="true"
                />
                {c.label}
              </button>
            );
          })}
          <span className="ml-1 text-[12.5px] text-zinc-400">
            可多选：再点一次取消该类型
          </span>
        </span>
      </div>
    </section>
  );
}
