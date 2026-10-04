/**
 * Harness 屏(**可编辑**)
 *
 * ── 这一版换掉了什么 ────────────────────────────────────────────
 *
 * 上一版整页只读,并在页头如实写着「本页只读,请直接去改文件」。那时这是对的:
 * 契约 `HarnessView.writable` 就是 `false`。现在写面已就位(writable: true),
 * 所以这一版把**编辑**搬进页面:
 *
 *   PUT  /api/harness/units/:unitId          { content }        → { ok, content, backupPath? }
 *   POST /api/harness/units/:unitId/reset    { confirm:"reset" }→ { ok, content }
 *   GET  /api/harness/units/:unitId/backups                     → { backups: [{file,path}] }
 *
 * ── 三条不许绕过的规矩(后端定的,前端照做)──────────────────────
 *
 *  1. **保存后用响应里的 `content` 当新状态。** 后端返回的是**回读**到的正文,
 *     不是回显入参(写面规矩③:报成功 = 真生效)。拿入参回显的话,「界面上改了、
 *     盘上没改」这种情况用户永远看不见。所以 `applyContent()` 只吃响应值 ——
 *     textarea 的内容永远等于「盘上真有的那份」,不是「我以为写进去的那份」。
 *
 *  2. **恢复出厂必须二次确认。** 后端要求 `{ confirm:"reset" }`,不传就 400。
 *     界面用**两段式按钮**(点一下变成「确认恢复出厂 / 取消」),不用
 *     `window.confirm` —— 确认态要留在页面上,用户能看着自己要动的东西按下去。
 *     「恢复出厂」≠「删文件」:找不到出厂副本时后端如实报 `no_factory_copy`,
 *     这里就把那句话原样显示,不假装恢复成功。
 *
 *  3. **`ceiling` / `writeKinds` 改不了,而且要说清楚为什么。** 它们是
 *     `ROLE_SPECS` 里的**代码内常量**,不是盘上的文件 —— 改它们要走代码评审
 *     (7-E 的架构裁决:集合文件突破不了上界)。不标注的话用户会以为「界面上
 *     没给编辑框 = 还没做」,然后去找一个不存在的开关。
 *
 * ── 页面上必须看得见的另外两件事(契约里逐字写明)────────────────
 *
 *   - **`loaded: false` 的提示词单元** —— 「角色声明了这个单元,但盘上没有对应
 *     文件:这条职责从没告诉过 agent」。这是 7-B 那一课的守卫。
 *   - **`blockedByCeiling` 非空必须显示** —— 越权条目对用户可见是纪律。
 */
import { useCallback, useEffect, useState } from "react";
import type { HarnessView, PromptUnitView } from "@shared/types/platform";
import {
  Clamp,
  Disclosure,
  EmptyState,
  Flag,
  KV,
  PageHeader,
  Pill,
  Section,
  StatStrip,
} from "@/components/ui/primitives";
import {
  ApiError,
  errorMessage,
  getHarness,
  listPromptUnitBackups,
  resetPromptUnit,
  updatePromptUnit,
} from "@/lib/api";

/** 一次保存 / 恢复的结果。`failed` 带上 `validIds` —— 后端在 `unknown_unit` 时给。 */
type OpState =
  | { kind: "idle" }
  | { kind: "busy"; what: "save" | "reset" }
  | { kind: "ok"; text: string }
  | { kind: "failed"; message: string; validIds?: string[] };

function failureOf(e: unknown): OpState {
  const message = errorMessage(e);
  if (e instanceof ApiError) {
    return {
      kind: "failed",
      message: `${e.code}: ${message}`,
      ...(e.validIds !== undefined ? { validIds: e.validIds } : {}),
    };
  }
  return { kind: "failed", message };
}

export function HarnessPage() {
  const [view, setView] = useState<HarnessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * 编辑中的正文,**按 unit id 存**。
   *
   * 为什么放在父层而不是每个 textarea 各存一份:同一个单元会被多个角色声明 ——
   * `collaboration.ask` 同时属于项目经理 / 执行者 / 质检审查员。若各存各的,
   * 在 A 角色改完保存,B 角色那张卡还会显示旧正文,用户会以为「没生效」。
   * 一份草稿 + 一份盘上正文(`unit.content`)就避免了这种自相矛盾。
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** 每个单元的备份份数。`-1` = 查不到(如实显示成「—」,不显示 0)。 */
  const [backups, setBackups] = useState<Record<string, number>>({});

  const refreshBackups = useCallback((unitId: string) => {
    listPromptUnitBackups(unitId)
      .then((r) => setBackups((b) => ({ ...b, [unitId]: r.backups.length })))
      .catch(() => setBackups((b) => ({ ...b, [unitId]: -1 })));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getHarness()
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setError(null);
        const ids = [...new Set(v.roles.flatMap((r) => r.promptUnits.map((u) => u.id)))];
        setDrafts(Object.fromEntries(v.roles.flatMap((r) => r.promptUnits.map((u) => [u.id, u.content]))));
        for (const id of ids) refreshBackups(id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshBackups]);

  /**
   * 保存 / 恢复成功后**唯一的**状态入口。参数只有 `content` —— 也就是后端回读的
   * 那一份。这里刻意不接受「入参正文」,从类型上就堵住「界面显示入参」的可能。
   */
  const applyContent = useCallback(
    (unitId: string, content: string) => {
      setDrafts((d) => ({ ...d, [unitId]: content }));
      setView((v) =>
        v === null
          ? v
          : {
              ...v,
              roles: v.roles.map((r) => ({
                ...r,
                promptUnits: r.promptUnits.map((u) =>
                  u.id === unitId ? { ...u, content, chars: content.length, loaded: true } : u,
                ),
              })),
            },
      );
      refreshBackups(unitId);
    },
    [refreshBackups],
  );

  const missing =
    view?.roles.flatMap((r) =>
      r.promptUnits.filter((u) => !u.loaded).map((u) => ({ role: r.displayName, unit: u })),
    ) ?? [];

  return (
    <div className="ss-page">
      <PageHeader
        title="Harness"
        hint="可编辑 · 每个角色的能力面与提示词单元"
        hintTitle="数据来源:GET /api/harness。提示词单元可直接编辑(保存前自动备份,可恢复出厂);ceiling 与 writeKinds 是代码内常量,本页改不了。"
        aside={
          view ? (
            <StatStrip
              items={[
                { label: "角色", value: view.roles.length },
                { label: "提示词单元", value: view.roles.reduce((n, r) => n + r.promptUnits.length, 0) },
                {
                  label: "缺失",
                  value: missing.length,
                  tone: missing.length > 0 ? "cinnabar" : undefined,
                  title: "声明了单元但盘上没有文件 —— 这条职责从没告诉过 agent",
                },
              ]}
            />
          ) : undefined
        }
      />

      {/* 页头这一条写的是**这次真能做什么**。写面缺位时说「只读」是诚实,
          写面有了还说只读就是在骗用户。 */}
      <Flag tone="mute">
        <span className="ss-body" style={{ color: "var(--bone-dim)" }}>
          提示词单元可以在这里直接改:改前自动备份(留最近 10 份),保存后显示的是
          后端回读到的正文;「恢复出厂」写回出厂字节(不是删文件)。 也可以绕开本页直接编辑文件:
          {view ? view.promptDir : "harness/system_prompts/"}。
          <br />
          工具集合文件目前只能直接编辑(本页不提供写面):
          {view ? view.toolsDir : "harness/tools/"}
          {" —— "}
          文件名必须是 <code>{"{role}"}.json</code>(即 business_manager / project_manager /
          worker / quality_reviewer),写错了不会被读取;改完不需要重启服务,
          每个新会话现读一次。上面每张卡里的「集合文件」一行就是它是否生效的实地。
        </span>
      </Flag>

      {/* 落在空处的意图:文件名写错(如 workers.json)会被安静忽略 —— 必须报出来。 */}
      {view !== null && view.strayToolSetFiles.length > 0 && (
        <Flag tone="cinnabar">
          <span className="ss-body" style={{ color: "var(--cinnabar)" }}>
            工具目录里有 {view.strayToolSetFiles.length} 个文件名不属于任何角色的 .json,
            它们不会被读取:{view.strayToolSetFiles.join(" · ")}
          </span>
        </Flag>
      )}

      {error !== null ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : loading && view === null ? (
        <EmptyState>加载中…</EmptyState>
      ) : view === null ? (
        <EmptyState>读不到 Harness 视图。</EmptyState>
      ) : (
        <>
          {missing.length > 0 && (
            <Flag tone="cinnabar">
              <span className="ss-body" style={{ color: "var(--cinnabar)" }}>
                有 {missing.length} 个提示词单元在盘上没有文件 —— 这几条职责从没告诉过 agent:
                {missing.map((m) => ` ${m.role}/${m.unit.id}`).join(" · ")}
              </span>
            </Flag>
          )}

          <div className="grid gap-3">
            {view.roles.map((r) => (
              <Section
                key={r.role}
                title={r.displayName}
                count={r.promptUnits.length}
                hint={r.clientFacing ? "甲方接口" : undefined}
                hintTitle={`role = ${r.role}`}
                aside={
                  <div className="flex items-center gap-1.5">
                    {r.clientFacing && <Pill tone="jade">甲方接口</Pill>}
                    <span className="ss-meta font-mono">{r.role}</span>
                  </div>
                }
              >
                <article className="sansheng-card p-3 flex flex-col gap-2">
                  <div className="flex flex-col">
                    <KV
                      label="能力"
                      value={`${r.ceiling.length} 项 · 代码内常量,改不了`}
                      title="ceiling 来自 ROLE_SPECS,是架构上界;集合文件与界面都突破不了它。要改得走代码评审。"
                    />
                    <KV
                      label="可写"
                      value={`${r.writeKinds.join(" · ") || "不可写"} · 代码内常量,改不了`}
                      title="writeKinds 同样来自 ROLE_SPECS(代码内常量),不是可编辑文件 —— 本页只提供提示词单元的编辑。"
                    />
                    <KV
                      label="边界拒"
                      value={r.boundaryDeny.length > 0 ? r.boundaryDeny.join(" · ") : "—"}
                      title="明示这个角色拿不到哪些工具。同样是代码内常量,本页改不了。"
                    />
                    <KV
                      label="实得工具"
                      value={
                        r.tools.length > 0
                          ? r.tools.join(" · ")
                          : "无(集合文件把工具面收空了,或还没有种子角色)"
                      }
                      title="已过三重门控:ROLE_SPECS[].ceiling(代码内常量)∧ 集合文件 harness/tools/{role}.json ∧ 执行点。"
                    />
                    <KV
                      label="集合文件"
                      value={
                        r.toolSet.state === "ok"
                          ? `生效中 · 收掉 ${r.toolSet.removedByToolSet.length} 个工具`
                          : r.toolSet.state === "absent"
                            ? "没有这个文件 · 按 ceiling 全集(出厂行为)"
                            : "文件无效 · 已退化成 ceiling 全集"
                      }
                      title={
                        `${r.toolSet.path}\n\nstate = ${r.toolSet.state}` +
                        "\n只有 ok 会真的收窄工具面;absent / invalid 都按 ceiling 全集求解。"
                      }
                    />
                  </div>

                  {/* 集合文件坏了必须响亮:此时权限**回落到 ceiling 全集**(方向上是放宽)。
                      「坏了」与「生效了」在界面上长得一样,是最危险的形态。 */}
                  {r.toolSet.state === "invalid" && (
                    <Flag tone="cinnabar">
                      <span className="ss-meta">集合文件无效,当前没有生效(权限按 ceiling 全集):</span>
                      <span className="ss-body">{r.toolSet.problem}</span>
                      <span className="ss-meta font-mono">{r.toolSet.path}</span>
                    </Flag>
                  )}

                  {/* 集合文件**生效的证据**:ceiling 本来会给、文件没要的那些工具。 */}
                  {r.toolSet.removedByToolSet.length > 0 && (
                    <Flag tone="mute">
                      <span className="ss-meta">被集合文件收掉(ceiling 给了、文件没要):</span>
                      <span className="ss-body">{r.toolSet.removedByToolSet.join(" · ")}</span>
                    </Flag>
                  )}

                  {/* 越权条目必须对用户可见 —— 架构裁决不能被静默吞掉。 */}
                  {r.blockedByCeiling.length > 0 && (
                    <Flag tone="cinnabar">
                      <span className="ss-meta">超出架构上界(集合文件写了但被 ceiling 拒绝):</span>
                      <span className="ss-body">{r.blockedByCeiling.join(" · ")}</span>
                    </Flag>
                  )}

                  {/* 拼错工具名不静默生效(见 solveToolset 的 unknownTools)。 */}
                  {r.unknownTools.length > 0 && (
                    <Flag tone="cinnabar">
                      <span className="ss-meta">集合文件里有不存在的工具名(已丢弃):</span>
                      <span className="ss-body">{r.unknownTools.join(" · ")}</span>
                    </Flag>
                  )}

                  <Disclosure summary={`能力清单(${r.ceiling.length})· 代码内常量,改不了`}>
                    <div className="flex flex-wrap gap-1">
                      {r.ceiling.map((c) => (
                        <span key={c} className="ss-pill" data-tone="bone">
                          {c}
                        </span>
                      ))}
                    </div>
                  </Disclosure>

                  <div className="flex flex-col">
                    <div className="ss-section" style={{ fontSize: 12 }}>
                      提示词单元
                    </div>
                    {r.promptUnits.length === 0 ? (
                      <div className="ss-note">这个角色没有声明任何提示词单元。</div>
                    ) : (
                      r.promptUnits.map((u) => (
                        <PromptUnitEditor
                          key={u.id}
                          unit={u}
                          value={drafts[u.id] ?? u.content}
                          backups={backups[u.id]}
                          onChange={(v) => setDrafts((d) => ({ ...d, [u.id]: v }))}
                          onApplied={(content) => applyContent(u.id, content)}
                        />
                      ))
                    )}
                  </div>
                </article>
              </Section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PromptUnitEditor({
  unit,
  value,
  backups,
  onChange,
  onApplied,
}: {
  unit: PromptUnitView;
  /** 当前草稿(父层持有,同一个 unit id 的多个角色共用一份) */
  value: string;
  /** 备份份数;undefined = 还没查到,-1 = 查不到 */
  backups: number | undefined;
  onChange: (next: string) => void;
  /** 保存 / 恢复成功 —— 参数是后端**回读**到的正文 */
  onApplied: (content: string) => void;
}) {
  const [op, setOp] = useState<OpState>({ kind: "idle" });
  const [confirming, setConfirming] = useState(false);

  const edited = value !== unit.content;
  const busy = op.kind === "busy";

  async function save() {
    if (busy) return;
    setOp({ kind: "busy", what: "save" });
    try {
      const res = await updatePromptUnit(unit.id, value);
      // 只认响应里的 content(回读值),不认刚才发出去的那份。
      onApplied(res.content);
      setOp({
        kind: "ok",
        text:
          `已保存 · 盘上 ${res.content.length} 字符` +
          (res.backupPath !== undefined ? " · 已备份" : " · 首次创建,无旧文件可备份"),
      });
    } catch (e) {
      setOp(failureOf(e));
    }
  }

  async function doReset() {
    if (busy) return;
    setConfirming(false);
    setOp({ kind: "busy", what: "reset" });
    try {
      const res = await resetPromptUnit(unit.id);
      onApplied(res.content);
      setOp({ kind: "ok", text: `已恢复出厂 · 盘上 ${res.content.length} 字符` });
    } catch (e) {
      setOp(failureOf(e));
    }
  }

  return (
    <div className="py-1" style={{ borderTop: "1px solid var(--ink-3)" }}>
      <div className="flex items-center gap-2 flex-wrap">
        {/* loaded=false 是本页最重要的一个信号:红色,不是灰色。 */}
        {unit.loaded ? (
          <Pill tone="bamboo">已加载</Pill>
        ) : (
          <Pill tone="cinnabar" title="声明了这个单元,但盘上没有对应文件 —— 这条职责从没告诉过 agent">
            缺失
          </Pill>
        )}
        <span className="ss-body" style={{ color: "var(--bone-dim)" }}>
          {unit.id}
        </span>
        {edited && <Pill tone="amber" title="编辑框里的内容和盘上的不一致">未保存</Pill>}
        <span className="ss-meta ml-auto" title="盘上正文的字符数(GET /api/harness 报的)">
          {unit.chars} 字符
        </span>
        <span
          className="ss-meta"
          title="该单元的历史备份份数(GET /api/harness/units/:id/backups,后端留最近 10 份)"
        >
          备份 {backups === undefined ? "…" : backups < 0 ? "—" : backups}
        </span>
      </div>
      <div className="ss-meta font-mono truncate" title={unit.path}>
        {unit.path}
      </div>

      {unit.content.length > 0 && (
        <Clamp lines={2} style={{ marginTop: 2 }}>
          {unit.content}
        </Clamp>
      )}

      <Disclosure summary={unit.loaded ? `编辑正文(${unit.chars} 字符)` : "编写正文(盘上还没有这个文件)"}>
        <div className="flex flex-col gap-1.5">
          <textarea
            value={value}
            rows={12}
            spellCheck={false}
            disabled={busy}
            onChange={(e) => onChange(e.target.value)}
            aria-label={`${unit.id} 正文`}
            placeholder={
              unit.loaded ? undefined : "这个单元在盘上还没有文件 —— 存下去就是它的第一次创建(没有旧内容可备份)。"
            }
            style={{
              background: "var(--ink-1)",
              border: "1px solid var(--ink-3)",
              borderRadius: 6,
              padding: "6px 8px",
              fontFamily: "monospace",
              fontSize: 11,
              lineHeight: 1.6,
              color: "var(--bone)",
              outline: "none",
              resize: "vertical",
              width: "100%",
              minHeight: 160,
            }}
          />

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className="sansheng-button-primary"
              style={{ padding: "4px 12px", fontSize: 12 }}
              disabled={busy || !edited}
              title={edited ? "写盘(改前自动备份;保存后显示后端回读的正文)" : "内容与盘上一致,无需保存"}
              onClick={() => void save()}
            >
              {op.kind === "busy" && op.what === "save" ? "保存中…" : "保存"}
            </button>

            {confirming ? (
              <>
                <button
                  type="button"
                  className="sansheng-button"
                  style={{ padding: "4px 12px", fontSize: 12, color: "var(--cinnabar)", borderColor: "var(--cinnabar)" }}
                  disabled={busy}
                  onClick={() => void doReset()}
                >
                  {op.kind === "busy" && op.what === "reset" ? "恢复中…" : "确认恢复出厂"}
                </button>
                <button
                  type="button"
                  className="sansheng-button"
                  style={{ padding: "4px 12px", fontSize: 12 }}
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  取消
                </button>
                <span className="ss-meta" style={{ color: "var(--cinnabar)" }}>
                  会丢弃本单元的全部改动(当前内容先落一份备份)
                </span>
              </>
            ) : (
              <button
                type="button"
                className="sansheng-button"
                style={{ padding: "4px 12px", fontSize: 12 }}
                disabled={busy}
                title="写回出厂副本的字节。不是删文件 —— 删文件会让这个单元变成「未装载」,agent 从此不知道这条规矩。"
                onClick={() => setConfirming(true)}
              >
                恢复出厂
              </button>
            )}

            {edited && (
              <button
                type="button"
                className="sansheng-button"
                style={{ padding: "4px 12px", fontSize: 12 }}
                disabled={busy}
                onClick={() => {
                  onChange(unit.content);
                  setOp({ kind: "idle" });
                }}
              >
                放弃改动
              </button>
            )}

            <span className="ss-meta ml-auto">
              单次请求,没有自动保存 —— 不点保存就不会写盘
            </span>
          </div>

          {op.kind === "ok" && (
            <span className="ss-meta" style={{ color: "var(--jade)" }}>
              {op.text}
            </span>
          )}

          {op.kind === "failed" && (
            <div className="sansheng-card p-2 text-xs" style={{ color: "var(--cinnabar)" }}>
              <div>操作失败:{op.message}</div>
              {op.validIds !== undefined && op.validIds.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  后端说这个 id 不认识。合法 id:{op.validIds.join(" · ")}
                </div>
              )}
            </div>
          )}
        </div>
      </Disclosure>
    </div>
  );
}
