/**
 * 「自己的工具与经验」—— 成员页「角色 harness」卡里的第二个折叠块(migration 040)
 *
 * ── 它是什么 / 不是什么 ─────────────────────────────────────────
 *
 * 三个执行角色各自的东西:一个不属于任何项目的仓库(里面一个工具一个目录)与一个
 * 按角色隔离的经验库。**这里没有审批** —— 用户裁决「自己的 rag 和代码仓库不需要
 * 我放行」。人能做的只有两件:踩刹车(停用 / 恢复一条工具)、删一条经验。
 *
 * ── 三条纪律 ───────────────────────────────────────────────────
 *
 *   ① **读不到 ≠ 没有**:仓库读面与经验读面各走一个 `DataState`;动作失败单独一行。
 *   ② **会拿走东西的动作两步确认**:第一下把按钮换成「确认…」,第二下才发请求。
 *      恢复一条工具不拿走东西,一步。
 *   ③ **不写角色名**:卡片头已经有角色名了(卡里只许出现一次),这里一律说「他」。
 *
 * 取数在 `useOwnKit.ts`;这里只排版。状态文字与颜色的判据也在这一处。
 */
import { useState, type ReactNode } from "react";
import type { AgentNoteView, OwnKitView, OwnToolView } from "@shared/types/platform";
import { Pill, type Tone } from "@/components/ui/primitives";
import { DataState } from "@/components/ui/DataState";
import type { OwnKitModel } from "@/components/harness/useOwnKit";

const KIND_LABEL: Readonly<Record<OwnToolView["kind"], string>> = { skill: "说明 + 脚本", mcp: "MCP 服务" };
const NOTE_KIND_LABEL: Readonly<Record<AgentNoteView["kind"], string>> = { lesson: "经验", research: "调研" };
const BTN = { padding: "1px 6px", fontSize: 11 } as const;

function day(ms: number): string {
  return new Date(ms).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** 折叠块标题的后缀(卡片头那份快照里有数才带;读不到就只有标题)。 */
export function ownKitSummarySuffix(own: OwnKitView | undefined): string {
  if (own === undefined || own.repoState === "unavailable") return "";
  const notes = own.notes === null ? "" : ` · 经验 ${own.notes.lesson + own.notes.research} 条`;
  return ` · 工具 ${own.tools.length} 个${notes}`;
}

/** 一条工具的状态:文字 + 颜色。格式不对、已停用、在用三种必须长得不一样。 */
export function ownToolStateLabel(tool: OwnToolView): { text: string; tone: Tone } {
  if (tool.state === "invalid") return { text: "格式不对", tone: "cinnabar" };
  if (tool.state === "disabled") return { text: "已停用", tone: "bone" };
  return { text: "在用", tone: "jade" };
}

function ToolRow({ tool, confirming, onDisable, onRestore, onCancel }: {
  tool: OwnToolView;
  /** 正在等第二次点击的那一条(`tool:<名字>`)。 */
  confirming: string | null;
  onDisable: () => void;
  onRestore: () => void;
  onCancel: () => void;
}): ReactNode {
  const label = ownToolStateLabel(tool);
  const waiting = confirming === `tool:${tool.name}`;
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono ss-body">{tool.name}</span>
        <span className="ss-meta">{KIND_LABEL[tool.kind]}</span>
        <Pill tone={label.tone}>{label.text}</Pill>
        {tool.state === "disabled" ? (
          <button type="button" className="sansheng-button" style={BTN} onClick={onRestore}>恢复</button>
        ) : tool.state === "invalid" ? null : waiting ? (
          <>
            <button type="button" className="sansheng-button" style={BTN} onClick={onDisable}>确认停用</button>
            <button type="button" className="sansheng-button" style={BTN} onClick={onCancel}>取消</button>
          </>
        ) : (
          <button type="button" className="sansheng-button" style={BTN} onClick={onDisable}>停用</button>
        )}
      </div>
      {tool.description !== "" && <span className="ss-meta">{tool.description}</span>}
      {tool.problem !== null && (
        <span className="ss-body" style={{ color: "var(--cinnabar)" }}>{tool.problem}</span>
      )}
      {tool.disabledAt !== null && <span className="ss-meta">停用于 {day(tool.disabledAt)}</span>}
    </li>
  );
}

function NoteRow({ note, confirming, onRemove, onCancel }: {
  note: AgentNoteView;
  confirming: string | null;
  onRemove: () => void;
  onCancel: () => void;
}): ReactNode {
  const waiting = confirming === `note:${note.id}`;
  return (
    <li className="flex flex-col gap-0.5">
      <details>
        <summary className="ss-body">
          <Pill tone="bone">{NOTE_KIND_LABEL[note.kind]}</Pill> {note.title}
          {note.status === "retired" ? "(已退休)" : ""}
        </summary>
        <div className="ss-note">
          {note.source !== null && <div className="ss-meta">出处:{note.source}</div>}
          <div className="ss-body" style={{ whiteSpace: "pre-wrap" }}>{note.content}</div>
          {note.status === "retired" && <div className="ss-meta">退休原因:{note.retireReason ?? "未写"}</div>}
          <div className="ss-meta">记于 {day(note.createdAt)} · 最后改于 {day(note.updatedAt)}</div>
        </div>
      </details>
      {waiting ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className="sansheng-button" style={BTN} onClick={onRemove}>确认删除</button>
          <button type="button" className="sansheng-button" style={BTN} onClick={onCancel}>取消</button>
        </div>
      ) : (
        <div>
          <button type="button" className="sansheng-button" style={BTN} onClick={onRemove}>删除</button>
        </div>
      )}
    </li>
  );
}

export function OwnKitSection({ model }: { model: OwnKitModel }): ReactNode {
  /** 正在等第二次点击的那一条:`tool:<名字>` 或 `note:<id>`。 */
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <DataState
        what="他自己的仓库"
        state={model.state}
        variant="inline"
        errorNote=" —— 这是「读不到」,不是「他没有工具」。"
        loadingLabel="正在读取他自己的仓库…"
        unavailable="读不到他自己的仓库(不是「他没有工具」)。"
      >
        {(own) => (
          <>
            {own.repoState === "unavailable" ? (
              <div className="ss-body" style={{ color: "var(--cinnabar)" }}>{own.problem ?? "仓库读不到"}</div>
            ) : (
              <div className="ss-meta">
                仓库:<span className="font-mono break-all">{own.repoDir}</span>
                {own.repoState === "missing" ? "(目录还没建出来)" : ""}
              </div>
            )}
            {own.repoState === "ready" && own.tools.length === 0 && <div className="ss-meta">还没有工具。</div>}
            {own.tools.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {own.tools.map((t) => (
                  <ToolRow
                    key={t.name}
                    tool={t}
                    confirming={confirming}
                    onDisable={() => {
                      if (confirming === `tool:${t.name}`) {
                        setConfirming(null);
                        void model.toggle(t.name, true);
                      } else {
                        setConfirming(`tool:${t.name}`);
                      }
                    }}
                    onRestore={() => void model.toggle(t.name, false)}
                    onCancel={() => setConfirming(null)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </DataState>

      <DataState
        what="他的经验库"
        state={model.notes}
        variant="inline"
        errorNote=" —— 这是「读不到」,不是「还没有经验」。"
        loadingLabel="正在读取他的经验库…"
        unavailable="读不到他的经验库(不是「还没有经验」)。"
      >
        {(notes) => (
          <>
            <form
              className="flex flex-wrap items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                model.submitSearch(model.input);
              }}
            >
              <input
                className="sansheng-input"
                style={{ maxWidth: 220 }}
                value={model.input}
                placeholder="搜他的经验(至少 2 个字)"
                aria-label="搜他的经验"
                onChange={(e) => model.setInput(e.target.value)}
              />
              <button type="submit" className="sansheng-button" style={BTN}>查询</button>
              {model.input !== "" && (
                <button
                  type="button"
                  className="sansheng-button"
                  style={BTN}
                  onClick={() => {
                    model.setInput("");
                    model.submitSearch("");
                  }}
                >
                  清空
                </button>
              )}
            </form>
            {notes.length === 0 ? (
              <div className="ss-meta">没有条目。</div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {notes.map((n) => (
                  <NoteRow
                    key={n.id}
                    note={n}
                    confirming={confirming}
                    onRemove={() => {
                      if (confirming === `note:${n.id}`) {
                        setConfirming(null);
                        void model.removeNote(n.id);
                      } else {
                        setConfirming(`note:${n.id}`);
                      }
                    }}
                    onCancel={() => setConfirming(null)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </DataState>

      {model.actionError !== null && (
        <div className="ss-body" style={{ color: "var(--cinnabar)" }}>操作失败:{model.actionError}</div>
      )}
    </div>
  );
}
