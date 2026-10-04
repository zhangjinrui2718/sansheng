/**
 * Harness 屏(**本次只读**)
 *
 * ── 为什么整页重写 ──────────────────────────────────────────────
 *
 * 旧页是「每个 agent 的雇员手册」:总表 + 三档生效徽章 + **写面**
 * (`GET/PUT /api/harness/facets/:facet/entries/:id`、`POST .../reset`,
 * 配套 PromptEditor / ToolsEditor / facetClient / shared 四个组件)。
 *
 * 新契约把 harness 明确收成**只读**:
 *
 *     GET /api/harness → HarnessView { roles, promptDir, writable: false }
 *
 * 没有 PUT、没有 facets、没有 reset。写面是单独一批的工作(它要重新实现旧系统
 * 7-O 的四条规矩:闭合注册表防路径穿越、备份是写的前置、报成功=真生效、
 * 恢复出厂≠删文件),**不顺手做**。所以这一页:
 *
 *   · 只读渲染 `HarnessView`;
 *   · `writable === false` 时必须**如实说出来**,而不是给一个点了没反应的编辑框;
 *   · 编辑入口改为「告诉你文件在哪」(promptDir + 每个单元的 path)。
 *
 * ── 页面上必须看得见的两件事(契约里逐字写明的)──────────────
 *
 *   1. **`loaded: false` 的提示词单元** —— 「角色声明了这个单元,但盘上没有对应
 *      文件:这条职责从没告诉过 agent」。契约原话:「必须让用户看得见,这是 7-B
 *      那一课的守卫」。
 *   2. **`ceiling` 是代码内常量** —— 不是可编辑文件,前端要如实标注。
 *      同理 `blockedByCeiling` 非空时必须显示(越权条目对用户可见是纪律)。
 */
import { useEffect, useState } from "react";
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
import { getHarness, errorMessage } from "@/lib/api";

export function HarnessPage() {
  const [view, setView] = useState<HarnessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getHarness()
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setError(null);
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
  }, []);

  const missing =
    view?.roles.flatMap((r) =>
      r.promptUnits.filter((u) => !u.loaded).map((u) => ({ role: r.displayName, unit: u })),
    ) ?? [];

  return (
    <div className="ss-page">
      <PageHeader
        title="Harness"
        hint="只读 · 每个角色的能力面与提示词单元"
        hintTitle="数据来源:GET /api/harness。本次只提供只读视图 —— 写面(编辑提示词 / 改工具集合 / 备份 / 恢复出厂)是单独一批的工作。"
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

      {/* 只读这件事必须在屏幕上说清楚,而不是让用户点进一个没有保存按钮的编辑器。 */}
      <Flag tone="mute">
        <span className="ss-body" style={{ color: "var(--bone-dim)" }}>
          本页只读。要改提示词,直接编辑下面每个单元给出的文件路径
          {view ? `(目录:${view.promptDir})` : ""}。
          {view?.writable === false ? " 写入接口(writable=false)尚未提供。" : ""}
        </span>
      </Flag>

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
                      value={`${r.ceiling.length} 项`}
                      title="ceiling 是代码内常量,不是可编辑文件"
                    />
                    <KV label="可写" value={r.writeKinds.join(" · ") || "不可写"} />
                    <KV
                      label="边界拒"
                      value={r.boundaryDeny.length > 0 ? r.boundaryDeny.join(" · ") : "—"}
                    />
                    <KV
                      label="实得工具"
                      value={r.tools.length > 0 ? r.tools.join(" · ") : "无(集合未接线)"}
                      title="已过三重门控:集合文件 ∧ ROLE_CEILING ∧ 执行点"
                    />
                  </div>

                  {/* 越权条目必须对用户可见 —— 架构裁决不能被静默吞掉。 */}
                  {r.blockedByCeiling.length > 0 && (
                    <Flag tone="cinnabar">
                      <span className="ss-meta">超出架构上界(集合文件写了但被 ceiling 拒绝):</span>
                      <span className="ss-body">{r.blockedByCeiling.join(" · ")}</span>
                    </Flag>
                  )}

                  <Disclosure summary={`能力清单(${r.ceiling.length})`}>
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
                      r.promptUnits.map((u) => <PromptUnit key={u.id} unit={u} />)
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

function PromptUnit({ unit }: { unit: PromptUnitView }) {
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
        <span className="ss-meta ml-auto">{unit.chars} 字符</span>
      </div>
      <div className="ss-meta font-mono truncate" title={unit.path}>
        {unit.path}
      </div>
      {unit.content.length > 0 && (
        <>
          <Clamp lines={2} style={{ marginTop: 2 }}>
            {unit.content}
          </Clamp>
          <Disclosure summary="单元正文(只读)">
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 11,
                lineHeight: 1.6,
                margin: 0,
                color: "var(--bone-dim)",
              }}
            >
              {unit.content}
            </pre>
          </Disclosure>
        </>
      )}
    </div>
  );
}
