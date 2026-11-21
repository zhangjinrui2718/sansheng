/**
 * 思考块(批次 UI U4:状态行去掉重复的「推演中」;A4:折叠状态与渲染面分开)
 *
 * 「推演中」此前在本块与 MessageList 的轮次头**各出现一次**;轮次头已经有了,
 * 这里删掉,只保留箭头随展开状态旋转(旧实现写死 ▾,展开后纹丝不动)。
 *
 * ── 本批次(设计 1 §2.12 的 A4):**默认折叠**,且折叠时真的看不到推理 ──
 *
 * 设计 1 §2.10.4 的裁决是「留,但默认折叠」—— 它是与你对话的那个人的推理,
 * 不是别人的;而它**留不住**(`thinkBuf` 被 push 之后没有读者,
 * `grep -rn 'kind: "thinking"' src/` = **0**,刷新即无 ⇒ 推理只存在于流式的那几秒里)。
 * 「历史里也能检查推理」的前提是**写入侧落库**,那是设计 1 §12 #13 的 open
 * question,不是本批次(展示层)的事。
 *
 * 两条纪律在这里落地:
 *
 * 1. **折叠状态是组件内状态,不进 store。** 它是一块正文的展示状态,进了 store
 *    就变成第二处真相 —— 还要额外为它编「刷新 / 换项目 / 换轮时怎么清」的规则。
 *    每个 `ThinkingBlock` 一个实例 ⇒ **每一轮(严格说每一块)的折叠各自独立**。
 * 2. **折叠时推理正文不进渲染产物。** 旧实现在折叠态显示推理正文的前 60 字
 *    预览(`text.slice(0, 60)`)—— 那让「折叠 = 看不到推理」在渲染产物里**不成立**
 *    (前 60 字就在 DOM 里,`grep` 一下就能读到)。现在折叠态只显示**字数**
 *    (元信息,不含推理内容),展开才渲染正文。
 *
 * ── 为什么切成「状态壳 + 纯展示面」────────────────────────────────
 *
 * 本仓前端测试跑在 node + `renderToStaticMarkup`(不引 jsdom/RTL,见
 * `tests/web/message-list.test.ts` 文件头),SSR **点不动按钮** —— 想验证
 * 「折叠时不出现 / 展开时才出现」这条判据,只能把 `open` 变成 prop 直测两条
 * 状态的真实渲染产物。`ThinkingBlock` 只负责持有那一位状态。
 */
import { useState } from "react";

interface Props {
  text: string;
  streaming?: boolean;
}

/**
 * 默认**折叠** —— 一条写出来的常量,好让「默认值是折叠」这件事在测试里可断言,
 * 而不是藏在 `useState(false)` 的字面量里(设计 1 §2.10.4)。
 */
export const THINKING_DEFAULT_OPEN = false;

export function ThinkingBlock({ text, streaming }: Props) {
  // ⚠️ 组件内状态,且**每个实例一份** —— 不跨轮共享,也不写进 store(A4 纪律)。
  const [open, setOpen] = useState(THINKING_DEFAULT_OPEN);
  return (
    <ThinkingDisclosure
      text={text}
      streaming={streaming}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    />
  );
}

/**
 * 思考块的**纯展示面**(导出给测试)。
 *
 * `open === false` 时渲染产物里**只有标签与字数**,没有任何推理字符;
 * `open === true` 才把 `text` 放进去。
 */
export function ThinkingDisclosure({
  text,
  streaming,
  open,
  onToggle,
}: {
  text: string;
  streaming?: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="rounded-md"
      style={{
        background: "rgba(94, 139, 126, 0.06)",
        border: "1px solid rgba(94, 139, 126, 0.25)",
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left"
        style={{ color: "var(--bone-dim)", fontSize: 12 }}
        title={open ? "收起推理过程" : "展开推理过程(内部推理,不是正式输出)"}
      >
        {/* 箭头随展开状态旋转 —— 旧实现写死 ▾,展开后箭头纹丝不动,读不出当前状态。 */}
        <span
          style={{
            color: "var(--jade)",
            display: "inline-block",
            transition: "transform var(--duration-160) var(--ease-out)",
            transform: open ? "rotate(90deg)" : "none",
          }}
        >
          ›
        </span>
        <span className="font-mono" style={{ fontSize: 11 }}>
          思考
        </span>
        {!open && (
          // 折叠态只报**长度**(元信息),不报内容 —— 旧版这里放的是正文前 60 字。
          <span className="sansheng-text-mute ml-2" style={{ fontSize: 11 }}>
            {text.length} 字
          </span>
        )}
      </button>
      {open && (
        <div
          className="px-3 py-2 sansheng-text-dim"
          style={{
            fontSize: 12,
            lineHeight: 1.6,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            borderTop: "1px solid rgba(94, 139, 126, 0.2)",
          }}
        >
          {text}
          {streaming && <span className="animate-caret">▍</span>}
        </div>
      )}
    </div>
  );
}
