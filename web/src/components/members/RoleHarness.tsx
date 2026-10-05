/**
 * 角色的 harness 面板(**可编辑**)—— 某个角色的提示词单元 · 工具面 · 常量
 *
 * ── 这一版合并了什么、为什么(2026-10-06)──────────────────────────
 *
 * 用户的原话(逐字):
 *
 *   「成员中我感觉在做什么事情,这个信息没有实时的同步到成员的这个页面来」
 *     —— 这是同一次改造的另一半,落在 `routes/Members.tsx` 的「正在做什么」。
 *   「成员的 harness 管理可以放在成员的 tab 下面,可以把「成员」「harness」
 *     这两个 tab 也合并了」
 *
 * 所以这个文件从 `routes/Harness.tsx` **搬进** `components/members/`:
 *
 *   - **删掉那个路由页面** —— 顶层那个 `harness` 路由/页签已从 `App.tsx` 与
 *     `TopBar.tsx` 里去掉。管理员(用户)本来就是在看「这个成员怎么样」的时候
 *     顺手想改它的提示词,而不是先切到一个只有管理员才去的页面。
 *   - **删掉那一行角色页签** —— 它做的事情,成员页的成员页签
 *     已经在做(一个项目里一人一角色,页签主体就是角色名)。两处各有一份页签
 *     正是用户一直在让我清理的重复。「一次只渲染一个角色」这条判据因此**改由
 *     成员页签承担**,断言在 `tests/web/members-activity.test.ts` 里。
 *   - **保留并导出**:`HarnessRolePane`(它现在就是**某个角色的 harness 面板**
 *     本身 —— 一次只画一个角色)、`roleIssueCount`(四类需要注意的处数之和,
 *     现在挂在**成员页签**的告警角标上)、`sharedUnitOwners`(跨角色算「共用于
 *     N 个角色」)、`failureOf` / `OpState`(保存与恢复的失败读数)。
 *   - **新增 `RoleHarnessSection`** —— 自足的、有状态的那一层:它自己取整份
 *     `GET /api/harness`(必须要整份:`sharedUnitOwners` 要跨角色才知道「共用
 *     于几个角色」),再挑出 `roles.find(r => r.role === role)` 那一条画成
 *     一个默认折叠的 `<Disclosure>`。它同时持有 `drafts`(按 unit id)与
 *     `backups`(按 unit id),因为写面(保存 / 恢复出厂)需要它们。
 *   - **`RoleHarnessDisclosure`** 是上面那层的**纯展示内核**(数据从 props 来,
 *     不取数、不持状态)。分出来只有一个理由:`RoleHarnessSection` 在 SSR 下
 *     取数(`useEffect` 不跑)永远停在「加载中」,而「传 A 角色时 B 角色独有的
 *     单元不许出现」这条判据必须能**在带真数据的情况下**被断言 —— 否则那条
 *     负样本是空转的(`renderToStaticMarkup` 里根本没有单元 id,断言恒真)。
 *
 * ── 写面四条规矩(后端定的,前端照做 —— 逐条从旧 `Harness.tsx` 搬来,没有重新发明)──
 *
 *   PUT  /api/harness/units/:unitId          { content }        → { ok, content, backupPath? }
 *   POST /api/harness/units/:unitId/reset    { confirm:"reset" }→ { ok, content }
 *   GET  /api/harness/units/:unitId/backups                     → { backups: [{file,path}] }
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
 *  4. **编辑区默认折叠**,否则一屏里又是十几段长正文(旧 `Harness.tsx` 可读性
 *     那一版修的正是这个)。
 *
 * ── 页面上必须看得见的另外几件事(契约里逐字写明)────────────────
 *
 *   - **`loaded: false` 的提示词单元** —— 「角色声明了这个单元,但盘上没有对应
 *     文件:这条职责从没告诉过 agent」。这是 7-B 那一课的守卫。
 *   - **`blockedByCeiling` 非空必须显示** —— 越权条目对用户可见是纪律。
 *   - **`toolsSolved === false` 不许显示成「0 个工具」** —— 那是「算不出来」
 *     (库里连这个角色的 agent 行都没有),不是「一个都没有」。
 *   - **`strayToolSetFiles` 非空必须显示** —— 文件名写错(如 `workers.json`)
 *     会被安静忽略;它原来是页级的告警,页面删掉后搬进这一层的面板里,否则
 *     等于把一条「落在空处的意图」静默丢掉。
 *   - **取数失败 / 还没取到,不许显示成「这个角色没有单元」** —— 三种「不知道」
 *     与「真的没有」必须在文字上分得开(本项目反复栽的形态)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  HarnessView, ProjectRole, PromptUnitView, RoleHarnessView,
} from "@shared/types/platform";
import {
  Clamp,
  Disclosure,
  EmptyState,
  Flag,
  KV,
  Pill,
  Section,
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
export type OpState =
  | { kind: "idle" }
  | { kind: "busy"; what: "save" | "reset" }
  | { kind: "ok"; text: string }
  | { kind: "failed"; message: string; validIds?: string[] };

export function failureOf(e: unknown): OpState {
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

/**
 * 每个单元被**哪些角色**声明(显示名)。
 *
 * 为什么要它:同一个文件被多个角色声明是**正常**的(`ROLE_SPECS[].promptUnits`
 * 里 `collaboration.ask` 3 处、`collaboration.convene` 2 处),但页面上它会在
 * 每个角色的面板里各出现一次、长得跟「三份不同的文件」一样。标注出来之后:
 * 「我改的是那个共用文件,会影响这几个角色」是**看得见**的。
 *
 * ⚠️ 它要的是**整份** harness 视图(所有角色),不是当前这一个角色 ——
 * 只拿着一个角色算不出「共用于几个角色」。
 */
export function sharedUnitOwners(
  roles: readonly RoleHarnessView[],
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const r of roles) {
    for (const u of r.promptUnits) {
      const cur = owners.get(u.id);
      if (cur === undefined) owners.set(u.id, [r.displayName]);
      else if (!cur.includes(r.displayName)) cur.push(r.displayName);
    }
  }
  return owners;
}

/** 一个角色身上**需要注意**的处数(成员页签上的告警角标)。四类互不重叠,直接相加。 */
export function roleIssueCount(role: RoleHarnessView): number {
  return (
    role.promptUnits.filter((u) => !u.loaded).length +
    (role.toolSet.state === "invalid" ? 1 : 0) +
    role.blockedByCeiling.length +
    role.unknownTools.length
  );
}

/**
 * 一个角色的 harness 面板。顺序刻意是**「我能不能用 → 我能改什么 → 代码内常量」**:
 *
 *   1. 摘要行 —— 单元 x/y、工具 n/m、集合文件状态(三个数就够判断「这角色正常吗」);
 *   2. 告警 —— 集合文件无效 / 缺单元 / 越权被拒 / 未知工具名(红的在前);
 *   3. 提示词单元 —— **默认折叠**(点开才出现 textarea,所以一屏里不会有十几段长正文);
 *   4. 工具面与代码内常量 —— 折起来:它们是**改不了**的东西,不该占首屏。
 *
 * 它是**纯 props** 的,而且**一次只画传进来的那一个角色** —— 旧的那一行角色页签
 * 提供的「一次只看一个角色」现在由成员页签承担(见本文件头)。
 */
export function HarnessRolePane({
  role,
  owners,
  drafts,
  backups,
  onDraftChange,
  onApplied,
}: {
  role: RoleHarnessView;
  /** unit id → 声明它的角色显示名(`sharedUnitOwners`) */
  owners: ReadonlyMap<string, string[]>;
  drafts: Readonly<Record<string, string>>;
  backups: Readonly<Record<string, number>>;
  onDraftChange: (unitId: string, next: string) => void;
  /** 保存 / 恢复成功 —— 参数是后端**回读**到的正文 */
  onApplied: (unitId: string, content: string) => void;
}) {
  const loaded = role.promptUnits.filter((u) => u.loaded).length;
  const missing = role.promptUnits.filter((u) => !u.loaded);
  const toolSetLabel =
    role.toolSet.state === "ok"
      ? `生效中 · 收掉 ${role.toolSet.removedByToolSet.length} 个`
      : role.toolSet.state === "absent"
        ? "无文件 · 按 ceiling 全集(出厂行为)"
        : "文件无效 · 已退化成 ceiling 全集";

  return (
    <Section
      title={role.displayName}
      count={role.promptUnits.length}
      hintTitle={`role = ${role.role}`}
      aside={
        <div className="flex items-center gap-1.5">
          {role.clientFacing && <Pill tone="jade">甲方接口</Pill>}
          <span className="ss-meta font-mono">{role.role}</span>
        </div>
      }
    >
      <article className="sansheng-card p-3 flex flex-col gap-3">
        {/* ① 摘要行:三个数就能判断这个角色是否正常 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="ss-meta" title="角色声明了这个单元、且盘上有文件">
            提示词单元{" "}
            <span style={{ color: missing.length > 0 ? "var(--cinnabar)" : "var(--jade)" }}>
              {loaded}/{role.promptUnits.length}
            </span>{" "}
            已加载
          </span>
          {/* ⚠️ 这两个数**不是分数关系**:ceiling 是**能力**条目、tools 是**工具名**,
              而一条能力可以展开成多个工具(`blackboard.read` → `board_list` +
              `board_read`)⇒ 真机上「工具 26 / 能力 22」是正常的。写成 `26/22`
              会被读成「26 用掉了 22 里的 26」(渲染真实数据时当场看出来的一处错)。
              ⚠️ 另外 `toolsSolved === false`(库里连这个角色的 agent 行都没有)时
              **不许显示「0 个」** —— 那是「算不出来」,不是「一个都没有」。 */}
          <span
            className="ss-meta"
            title="能力 = ceiling 的条目数(代码内常量);实得工具 = 工具名个数 —— 一条能力可展开成多个工具,所以工具数常大于能力数,两者不是分数关系"
          >
            能力 <span style={{ color: "var(--bone-dim)" }}>{role.ceiling.length}</span> 项 ·{" "}
            {/* ⚠️ 判据是 **`=== false`**,不是 `!toolsSolved` —— 字段缺失(前端比后端新,
                例如只刷新了页面而没重启进程)时必须**退化回旧行为**(照常显示计数),
                否则会把「旧后端没这个字段」误报成「组织未播种」。契约只增字段,
                前端就要能容忍这个字段不存在。 */}
            {role.toolsSolved !== false ? (
              <>
                实得工具 <span style={{ color: "var(--bone)" }}>{role.tools.length}</span> 个
              </>
            ) : (
              <span
                style={{ color: "var(--cinnabar)" }}
                title="库里没有这个角色的 agent 行(组织还没播种,或刚被重置)—— 工具面求解不了。它**不是**「0 个工具」。"
              >
                实得工具 求解不了(组织未播种)
              </span>
            )}
          </span>
          <span className="ss-meta" title={role.toolSet.path}>
            集合文件{" "}
            <span
              style={{
                color:
                  role.toolSet.state === "ok"
                    ? "var(--jade)"
                    : role.toolSet.state === "invalid"
                      ? "var(--cinnabar)"
                      : "var(--bone-dim)",
              }}
            >
              {toolSetLabel}
            </span>
          </span>
          {role.writeKinds.length > 0 && (
            <span className="ss-meta" title="writeKinds:这个角色能往库里写哪几类记录(代码内常量)">
              可写 {role.writeKinds.length} 类
            </span>
          )}
        </div>

        {/* ② 告警:红的在前。四类都不会静默 —— 这是纪律,不是装饰。 */}
        {missing.length > 0 && (
          <Flag tone="cinnabar">
            <span className="ss-meta">
              有 {missing.length} 个单元声明了但盘上没有文件 —— 这几条职责从没告诉过 agent:
            </span>
            <span className="ss-body">{missing.map((u) => u.id).join(" · ")}</span>
          </Flag>
        )}

        {role.toolSet.state === "invalid" && (
          <Flag tone="cinnabar">
            <span className="ss-meta">集合文件无效,当前没有生效(权限按 ceiling 全集):</span>
            <span className="ss-body">{role.toolSet.problem}</span>
            <span className="ss-meta font-mono">{role.toolSet.path}</span>
          </Flag>
        )}

        {role.blockedByCeiling.length > 0 && (
          <Flag tone="cinnabar">
            <span className="ss-meta">超出架构上界(集合文件写了但被 ceiling 拒绝):</span>
            <span className="ss-body">{role.blockedByCeiling.join(" · ")}</span>
          </Flag>
        )}

        {role.unknownTools.length > 0 && (
          <Flag tone="cinnabar">
            <span className="ss-meta">集合文件里有不存在的工具名(已丢弃):</span>
            <span className="ss-body">{role.unknownTools.join(" · ")}</span>
          </Flag>
        )}

        {role.toolSet.removedByToolSet.length > 0 && (
          <Flag tone="mute">
            <span className="ss-meta">被集合文件收掉(ceiling 给了、文件没要):</span>
            <span className="ss-body">{role.toolSet.removedByToolSet.join(" · ")}</span>
          </Flag>
        )}

        {/* ③ 提示词单元:这一块才是用户在找的东西,所以它排在常量前面 */}
        <div className="flex flex-col">
          <div className="ss-section" style={{ fontSize: 12 }}>
            提示词单元 · 可编辑
          </div>
          {role.promptUnits.length === 0 ? (
            <div className="ss-note">这个角色没有声明任何提示词单元。</div>
          ) : (
            role.promptUnits.map((u) => (
              <PromptUnitEditor
                key={u.id}
                unit={u}
                value={drafts[u.id] ?? u.content}
                backups={backups[u.id]}
                sharedWith={owners.get(u.id) ?? []}
                onChange={(v) => onDraftChange(u.id, v)}
                onApplied={(content) => onApplied(u.id, content)}
              />
            ))
          )}
        </div>

        {/* ④ 改不了的东西折起来 —— 它们重要,但不该占首屏 */}
        <Disclosure summary={`工具面与代码内常量(改不了)· 能力 ${role.ceiling.length} 项`}>
          <div className="flex flex-col">
            <KV
              label="能力"
              value={`${role.ceiling.length} 项 · 代码内常量,改不了`}
              title="ceiling 来自 ROLE_SPECS,是架构上界;集合文件与界面都突破不了它。要改得走代码评审。"
            />
            <KV
              label="可写"
              value={`${role.writeKinds.join(" · ") || "不可写"} · 代码内常量,改不了`}
              title="writeKinds 同样来自 ROLE_SPECS(代码内常量),不是可编辑文件 —— 这里只提供提示词单元的编辑。"
            />
            <KV
              label="边界拒"
              value={role.boundaryDeny.length > 0 ? role.boundaryDeny.join(" · ") : "—"}
              title="明示这个角色拿不到哪些工具。同样是代码内常量,这里改不了。"
            />
            <KV
              label="实得工具"
              value={
                role.tools.length > 0
                  ? role.tools.join(" · ")
                  : "无(集合文件把工具面收空了,或还没有种子角色)"
              }
              title="已过三重门控:ROLE_SPECS[].ceiling(代码内常量)∧ 集合文件 harness/tools/{role}.json ∧ 执行点。"
            />
            <KV
              label="集合文件"
              value={toolSetLabel}
              title={
                `${role.toolSet.path}\n\nstate = ${role.toolSet.state}` +
                "\n只有 ok 会真的收窄工具面;absent / invalid 都按 ceiling 全集求解。" +
                (role.toolSet.allow.length > 0 ? `\n\n文件里的 allow:${role.toolSet.allow.join(" · ")}` : "") +
                (role.toolSet.deny.length > 0 ? `\n文件里的 deny:${role.toolSet.deny.join(" · ")}` : "")
              }
            />
            <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
              {role.ceiling.map((c) => (
                <span key={c} className="ss-pill" data-tone="bone">
                  {c}
                </span>
              ))}
            </div>
          </div>
        </Disclosure>
      </article>
    </Section>
  );
}

/**
 * 「某个角色的 harness 面板」的**纯展示内核**:数据全从 props 来,不取数、不持状态。
 *
 * 为什么单独一层:`RoleHarnessSection` 自己取数 ⇒ 在 `renderToStaticMarkup`(SSR,
 * `useEffect` 不执行)里它**永远停在「加载中」**,一个单元 id 都不会渲染出来。
 * 于是「传 A 角色时 B 角色独有的单元不许出现」这条负样本会**恒真**(页面里根本
 * 没有那些 id)—— 本项目对「空转的检查」有明确的警惕。把纯的这一层导出,
 * 测试就能拿一份**带完整数据**的 `HarnessView` 走**同一条渲染路径**断言。
 *
 * `role` 是**角色**,不是成员 id:一个项目里一人一角色,成员页把
 * `member.role` 传下来,和旧的角色页签选中的角色是同一个东西。
 */
export function RoleHarnessDisclosure({
  role,
  view,
  loading,
  error,
  drafts,
  backups,
  defaultOpen = false,
  onDraftChange,
  onApplied,
}: {
  role: ProjectRole;
  /** 整份 harness 视图(所有角色)—— 共用的标注要跨角色算 */
  view: HarnessView | null;
  loading: boolean;
  /** 取数失败的原文;`null` = 没失败 */
  error: string | null;
  drafts: Readonly<Record<string, string>>;
  backups: Readonly<Record<string, number>>;
  defaultOpen?: boolean;
  onDraftChange: (unitId: string, next: string) => void;
  onApplied: (unitId: string, content: string) => void;
}) {
  const owners = useMemo(
    () => (view === null ? new Map<string, string[]>() : sharedUnitOwners(view.roles)),
    [view],
  );
  const found = view === null ? null : (view.roles.find((r) => r.role === role) ?? null);
  const issues = found === null ? 0 : roleIssueCount(found);

  return (
    <Disclosure
      // ⚠️ 角标数字来自 `roleIssueCount`,**只在 > 0 时**带上 —— 0 处时写一个
      // 「0 处需要注意」等于把「没问题」也刷成一条要读的字。
      summary={
        "角色 harness(提示词单元 · 工具面 · 常量)" +
        (issues > 0 ? ` · ${issues} 处需要注意` : "")
      }
      defaultOpen={defaultOpen}
    >
      {error !== null ? (
        // ⚠️ 三种「不知道」必须与「真的没有」分得开:`getHarness` 失败是**读不到**,
        // 不能说成「这个角色没有单元」。
        <div className="sansheng-card p-2 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error} —— 这是「读不到 harness 视图」,不是「这个角色没有提示词单元」。
        </div>
      ) : loading && view === null ? (
        <EmptyState>正在读取 harness 视图…</EmptyState>
      ) : view === null ? (
        <EmptyState>读不到 harness 视图。</EmptyState>
      ) : found === null ? (
        <EmptyState>
          这一份 harness 视图里没有角色 {role}(与「它没有提示词单元」是两件事)。
        </EmptyState>
      ) : (
        <>
          {/* 落在空处的意图:文件名写错(如 workers.json)会被安静忽略 —— 必须报出来。
              它原来是 harness 页页级的告警,页面并进成员页后搬到这里;不搬就等于
              把一条「有声明没读者」的证据静默丢掉。 */}
          {view.strayToolSetFiles.length > 0 && (
            <Flag tone="cinnabar">
              <span className="ss-body" style={{ color: "var(--cinnabar)" }}>
                工具目录里有 {view.strayToolSetFiles.length} 个文件名不属于任何角色的
                .json,它们不会被读取:{view.strayToolSetFiles.join(" · ")}
                (文件名必须是 {"{role}"}.json)
              </span>
            </Flag>
          )}
          <HarnessRolePane
            role={found}
            owners={owners}
            drafts={drafts}
            backups={backups}
            onDraftChange={onDraftChange}
            onApplied={onApplied}
          />
        </>
      )}
    </Disclosure>
  );
}

/**
 * 成员的 tab 底下那一块「角色 harness」—— **自足**:自己取整份 harness 视图,
 * 自己持有草稿与备份份数,自己按 unit id 应用保存 / 恢复的**回读值**。
 *
 * 为什么必须要**整份**视图:面板上「共用于 N 个角色」要跨角色数
 * (`sharedUnitOwners`),只拿当前角色的那一条算不出来。
 *
 * 为什么它自己取数而不是复用页面的 `useHarnessRoles()`:面板要能独立成立
 * (成员页只把 `role` 交给它)。⚠️ 已知代价(报告里也写了):页面那一份走
 * `lib/data.ts` 的**模块级缓存**(`loadHarnessOnce`),这一份走 `getHarness()`
 * 直取 ⇒ 在面板里保存之后,页面用来画**页签角标**的 `roleIssueCount` 仍是
 * 进入页面那一刻的旧数(要刷新才跟上)。面板自己显示的正文是回读值,不受影响。
 * 反过来,`loadHarnessOnce` 的缓存失效由 `project_opened` / 「重置数据」触发 ——
 * 那也是页面那一份刷新的时候。
 */
export function RoleHarnessSection({
  role,
  defaultOpen = false,
  onSaved,
}: {
  role: ProjectRole;
  /** 默认折叠 —— 这一块是管理面,不该占成员面板的首屏 */
  defaultOpen?: boolean;
  /**
   * 一次保存 / 恢复出厂**成功之后**通知页面。
   *
   * 页面用它把 `useHarnessRoles({ revision })` 推一格 —— 那一份是页签角标
   * (`roleIssueCount`)的来源,而它读的是模块级缓存 ⇒ 不通知的话,刚补上的缺单元
   * 仍会顶着「N 处需要注意」不放(见 `lib/data.ts` 里 `revision` 的说明)。
   */
  onSaved?: () => void;
}) {
  const [view, setView] = useState<HarnessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * 编辑中的正文,**按 unit id 存**。
   *
   * 为什么按 unit id 而不是每个 textarea 各存一份:同一个单元会被多个角色声明 ——
   * `collaboration.ask` 同时属于项目经理 / 工程师 / 质检。若各存各的,
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
      // 盘上的正文变了 ⇒ 让页面那一份(页签角标的来源)重取
      onSaved?.();
    },
    [refreshBackups, onSaved],
  );

  return (
    <RoleHarnessDisclosure
      role={role}
      view={view}
      loading={loading}
      error={error}
      drafts={drafts}
      backups={backups}
      defaultOpen={defaultOpen}
      onDraftChange={(unitId, next) => setDrafts((d) => ({ ...d, [unitId]: next }))}
      onApplied={applyContent}
    />
  );
}

function PromptUnitEditor({
  unit,
  value,
  backups,
  sharedWith,
  onChange,
  onApplied,
}: {
  unit: PromptUnitView;
  /** 当前草稿(父层持有,同一个 unit id 的多个角色共用一份) */
  value: string;
  /** 备份份数;undefined = 还没查到,-1 = 查不到 */
  backups: number | undefined;
  /** 声明了这个单元的**全部**角色显示名(多于一个 = 共用同一个文件) */
  sharedWith: readonly string[];
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
    <div className="py-1.5" style={{ borderTop: "1px solid var(--ink-3)" }}>
      {/* ── 摘要行:默认只显示这一行(以前每个单元都摊开一个 textarea)── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* loaded=false 是最重要的一个信号:红色,不是灰色。 */}
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
        {/* 共用文件:改了会影响这几个角色 —— 写在用户看得见的地方 */}
        {sharedWith.length > 1 && (
          <Pill
            tone="cyan"
            title={`这是**同一个文件**,被 ${sharedWith.length} 个角色声明:${sharedWith.join(" · ")}。改它会影响这几个角色。`}
          >
            共用于 {sharedWith.length} 个角色
          </Pill>
        )}
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

      {unit.content.length > 0 && (
        <Clamp lines={2} style={{ marginTop: 2 }}>
          {unit.content}
        </Clamp>
      )}

      {/* 编辑区**默认折叠** —— 一屏里不再有十几段长正文。
          展开后仍是完整的老行为(回读值当状态、两段式确认、失败原样显示)。 */}
      <Disclosure
        summary={unit.loaded ? `编辑正文(${unit.chars} 字符)` : "编写正文(盘上还没有这个文件)"}
      >
        <div className="flex flex-col gap-1.5">
          <div className="ss-meta font-mono truncate" title={unit.path}>
            {unit.path}
          </div>
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
