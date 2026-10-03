/**
 * Sansheng UI · 交付物块(批次 7-I B)
 *
 * 解决的缺陷:plan 跑完后,executor 写出的产物(可能是一份几千字的技术方案)
 * 只躺在 blackboard 里,用户在对话里只能看到一行「完成 3/5」。本块把
 * `plan_done` 携带的 `deliveries` 直接渲染进对话 —— **产物第一次到了用户眼前**。
 *
 * 交互取舍(为什么默认折叠):
 *   - 一次 plan 可能产出多条交付,全展开会把聊天页首屏撑爆;
 *   - 但**必须一眼看见「有交付物」** —— 否则又会退化成「做完但不知道做没做」。
 *   所以:默认折叠成一行标题条(篇数 + 标题),点开展开正文。
 *
 * 视觉:沿用既有 token(ink/bone/jade/amber),不引入新配色、不引新依赖
 * (与 Batch U4 前端瘦身的纪律一致 —— 默认上屏中文字数要克制)。
 */
import { useState } from "react";
import type { DeliveryItem } from "@shared/types/chat";

export function DeliveryBlock({ items }: { items: DeliveryItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const titles = items.map((i) => i.title).join("、");

  return (
    <div
      className="rounded-lg"
      style={{ border: "1px solid var(--ink-3)", background: "var(--ink-1)", overflow: "hidden" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "10px 14px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
        title={open ? "收起交付内容" : "展开交付内容"}
      >
        <span style={{ color: "var(--jade)", fontSize: 12 }}>{open ? "▾" : "▸"}</span>
        <span style={{ color: "var(--bone)", fontSize: 13, fontWeight: 500 }}>
          交付物 · {items.length} 篇
        </span>
        <span
          style={{
            color: "var(--bone-dim)",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {titles.length > 60 ? `${titles.slice(0, 60)}…` : titles}
        </span>
      </button>

      {open &&
        items.map((item) => (
          <div key={item.id} style={{ borderTop: "1px solid var(--ink-2)", padding: "12px 14px" }}>
            <div style={{ color: "var(--bone)", fontSize: 13, marginBottom: 2 }}>{item.title}</div>
            {item.todoTitle && (
              <div style={{ color: "var(--bone-mute)", fontSize: 11, marginBottom: 8 }}>
                对应工单:{item.todoTitle}
              </div>
            )}
            <div
              style={{
                color: "var(--bone-dim)",
                fontSize: 13,
                lineHeight: 1.7,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {item.body}
            </div>
            <div style={{ color: "var(--bone-mute)", fontSize: 10, marginTop: 8 }}>
              工件 {item.id} · 同样内容见「工件」页
            </div>
          </div>
        ))}
    </div>
  );
}
