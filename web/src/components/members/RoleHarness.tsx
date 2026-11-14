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
 *     本体 —— 一次只画一个角色)、`roleIssueCount`(四类需要注意的处数之和,
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
 *
 * ── 2026-10-06(同日第三刀):为什么 harness 要**单独成一张卡**──────────
 *
 * 用户的原话(逐字):
 *
 *   「成员中,角色 harness 单独放一个卡片出来,未来角色的 harness 配置就放在
 *     这个地方」
 *
 * 所以这一版把 harness 从 `MemberPane`(一个成员一块大卡片)内部**搬出来**,
 * 在同一个 tab 面板里、成员面板**之下**另起一块。两个理由:
 *
 *   1. **归属**:它描述的是**角色**(能力面 / 提示词单元 / 工具集合文件),
 *      不是某个人此刻在干什么 —— 塞在「他产生了什么对话 / 他产出了什么工件」
 *      中间,会被读成「这个成员的又一项活动」。
 *   2. **去处**:它是**未来角色 harness 配置**的唯一落点(用户原话)。它必须
 *      在自己的卡片头上一眼看出「这个角色的 harness 正不正常」(状态摘要 +
 *      告警处数),而**可编辑的内容默认折叠** —— 一屏里不该又是十几段长正文。
 *
 * 卡片头(折叠状态下也读得到的部分)由本文件的 `RoleHarnessDisclosure` 绘制:
 * 标题「角色 harness」· 角色名(悬停给出「这里改什么、什么改不了」)· `roleIssueCount`
 * 的告警 Pill(仅 > 0)· 一行状态摘要(单元 x/y · 能力 n 项 · 实得工具 m 个 ·
 * 集合文件状态)。`HarnessRolePane` 因此多了一个 `embedded`:嵌进这张卡时
 * **不再渲染它自己的 `Section` 外壳与 aside**(否则展开后卡片套卡片、同一个
 * 角色名出现两次)。
 *
 * ── 2026-10-08:提示词单元的呈现 + 工具表(用户点名两处)────────────────
 *
 * 用户的原话(逐字):
 *
 *   「成员tab下面的harness,
 *     1. 提示词单元可以收起,不要展示那么长,我觉得可以截断前500个字,然后两个
 *        按钮,一个按钮展开全部,一个按钮编辑
 *     2. 工具 做一个表格,按照类型、名称、作用来,现在搞一对英文名称的list,
 *        完全不知道都有些啥」
 *
 * 两处都改在这一层,判据在 `tests/web/harness-by-role.test.ts`:
 *
 *   - **`PromptUnitEditor`**:正文默认只画**前 {@link UNIT_PREVIEW_CHARS} 个字**
 *     (旧形状是 `Clamp lines={2}` —— 按行截断在不同宽度下截掉的内容不一样),
 *     下面两个按钮「展开全部 / 收起」与「编辑 / 收起编辑」。编辑区**默认不出现**
 *     (以前是一个默认折叠的 `<Disclosure>`)。
 *   - **`ToolTable`**(`components/members/ToolTable.tsx`):工具面从「一串英文名」
 *     换成三列表格 —— 类型(能力的中文分组)/ 名称 / 作用(工具注册表里写给模型的
 *     原文说明)。数据来自 `RoleHarnessView.toolBriefs`(`tools/briefs.ts` 转写),
 *     **前端不另写一张中文名表** —— 那会得到第二份会漂开的「这个工具是干嘛的」。
 *
 * ── 2026-11-14:抽出共享层 +「Harness 管理」页回场 ────────────────────
 *
 * 跨角色的「Harness 管理」页(`routes/HarnessManage.tsx`,**路由有、页签没有**
 * —— 导航恒 6 项)与成员页这张卡要的是**同一批事实与同一个编辑器**。所以可复用件
 * 抽到 `components/harness/` 下,**本文件改为引用同一份**(不是抄一份):
 *
 *   - `harness/judgments.ts` —— 纯判据(`roleIssueCount` / `sharedUnitOwners` /
 *     `harnessStatusText` / `toolCountText` / `toolSetStateDetail` / `OpState` /
 *     `failureOf`),本文件 re-export 它们以保住老 import 路径;
 *   - `harness/PromptUnitEditor.tsx` —— 编辑器(500 字预览 / 编辑区 / 两段式确认);
 *   - `harness/Blocks.tsx` —— 告警(`MissingUnitsAlert` / `ToolSetAlerts`)、
 *     工具面(`ToolSurface`)与代码内常量(`RoleConstants`)三段;
 *   - `harness/useHarnessWorkspace.ts` —— `RoleHarnessSection` 的有状态层
 *     (取整份视图 + 草稿 + 备份数 + 回读值入口)。
 *
 * 本文件留下的只有**这个页面的形状**:卡片头(标题 + 角色名 + 告警 Pill + 状态
 * 摘要 + 默认折叠的配置)与 `embedded` 规矩 —— 那是成员页这张卡的判据,判据在
 * `tests/web/harness-by-role.test.ts`。卡片头新增一个**入口链接**(真 `<a href>`,
 * 带当前角色参数)指向管理页;入口链接是导航,不是数据,所以不取数也在。
 */
import { useMemo } from "react";
import type { HarnessView, ProjectRole, RoleHarnessView } from "@shared/types/platform";
import { Disclosure, EmptyState, Flag, Pill, Section } from "@/components/ui/primitives";
import { DataState, remoteOf } from "@/components/ui/DataState";
import {
  MissingUnitsAlert,
  RoleConstants,
  ToolSetAlerts,
  ToolSurface,
} from "@/components/harness/Blocks";
import { PromptUnitEditor } from "@/components/harness/PromptUnitEditor";
import {
  harnessStatusText,
  missingUnits,
  roleIssueCount,
  sharedUnitOwners,
  toolSetStateDetail,
} from "@/components/harness/judgments";
import { useHarnessWorkspace } from "@/components/harness/useHarnessWorkspace";
import { ROLE_LABEL } from "@/lib/vocab";
import { toHash, toRoute } from "@/lib/route";

// ── 兼容再导出:老 import 路径(`@/components/members/RoleHarness`)继续成立 ──
// 判据的实现搬去了 `components/harness/`,但成员页与两份既有测试仍从这里 import
// —— re-export 是**同一份实现**的另一个门牌,不是第二份事实。
export {
  failureOf,
  harnessStatusText,
  roleIssueCount,
  sharedUnitOwners,
} from "@/components/harness/judgments";
export type { OpState } from "@/components/harness/judgments";
export {
  PromptUnitEditor,
  PromptUnitEditForm,
  UNIT_PREVIEW_CHARS,
  unitPreview,
} from "@/components/harness/PromptUnitEditor";
export { useHarnessWorkspace } from "@/components/harness/useHarnessWorkspace";

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
 *
 * `embedded`(默认 `false` = 老形状)为真时**只画里面那一段内容**:不渲染自己的
 * `Section` 外壳与 `aside`,也不套一层 `sansheng-card`。它被
 * `RoleHarnessDisclosure` 嵌进「角色 harness」那张卡时用 —— 外层卡片头已经承担了
 * 标题与角色名,再画一遍就是**卡片套卡片 + 同一个角色名出现两次**。
 */
export function HarnessRolePane({
  role,
  owners,
  drafts,
  backups,
  onDraftChange,
  onApplied,
  embedded = false,
}: {
  role: RoleHarnessView;
  /** unit id → 声明它的角色显示名(`sharedUnitOwners`) */
  owners: ReadonlyMap<string, string[]>;
  drafts: Readonly<Record<string, string>>;
  backups: Readonly<Record<string, number>>;
  onDraftChange: (unitId: string, next: string) => void;
  /** 保存 / 恢复成功 —— 参数是后端**回读**到的正文 */
  onApplied: (unitId: string, content: string) => void;
  /** 嵌进外层「角色 harness」卡片(默认 `false` = 独立的 Section + 卡片) */
  embedded?: boolean;
}) {
  // 「缺失」的公式只有一处(`missingUnits`,与角标/管理页同源)。
  const missing = missingUnits(role);
  const loaded = role.promptUnits.length - missing.length;
  // 摘要行的「集合文件」一格:状态 + (只有 ok 时)「收掉 N 个」—— 判据在
  // `toolSetStateDetail`,面板摘要行与管理页的工具面共用,两处不会分叉。
  const toolSetLabel = toolSetStateDetail(role);

  // 里面那一段内容(摘要行 / 告警 / 提示词单元 / 工具面与常量)。两种外壳共用它。
  const body = (
    <>
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
          title="工具不是能力的分数:一条能力可展开成多个工具"
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
              title="组织还没播种或刚被重置 · 不是「0 个工具」"
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

      {/* ② 告警:红的在前。四类都不会静默 —— 这是纪律,不是装饰。
          两条告警组件在 `harness/Blocks.tsx`,成员卡与管理页共用同一份措辞。 */}
      <MissingUnitsAlert missing={missing} />
      <ToolSetAlerts role={role} />

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

      {/* ④ 改不了的东西折起来 —— 它们重要,但不该占首屏。
          两段共用 `harness/Blocks.tsx`:管理页把它们**摊开**成两节,这里**折起来**。 */}
      <Disclosure summary={`工具面与代码内常量(改不了)· 能力 ${role.ceiling.length} 项`}>
        <RoleConstants role={role} />
        <ToolSurface role={role} />
      </Disclosure>
    </>
  );

  // 嵌进外层卡片时:不渲染自己的 Section 外壳、不套第二层卡片。
  if (embedded) {
    return <div className="flex flex-col gap-3">{body}</div>;
  }

  return (
    <Section
      title={role.displayName}
      count={role.promptUnits.length}
      aside={
        <div className="flex items-center gap-1.5">
          {role.clientFacing && <Pill tone="jade">甲方接口</Pill>}
          <span className="ss-meta font-mono">{role.role}</span>
        </div>
      }
    >
      <article className="sansheng-card p-3 flex flex-col gap-3">{body}</article>
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
 *
 * ⚠️ 2026-10-06(第三刀):它现在画的是**整张卡**,不只是那个折叠块 ——
 * `Section`(标题「角色 harness」+ 角色名 + 告警 Pill)+ 卡片头的**状态摘要行**
 * (在 `<details>` 外面,不展开也读得到)+ 默认折叠的配置。卡片本体只能有**一处**
 * 真相,所以标题与角色名在这里,`HarnessRolePane` 嵌进来时用 `embedded` 关掉
 * 它自己那一份外壳。
 *
 * ⚠️ 2026-11-14:卡片头的 aside 里多了一个**入口链接**(「打开 Harness 管理 →」,
 * 真 `<a href>` 带当前角色参数)—— 成员页这张卡是管理页的入口之一;链接是导航,
 * 不是数据,所以与告警 Pill 一样在折叠状态下也读得到。
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
  /** 卡片头那一行是不是要示警(缺单元 / 集合文件坏 / 越权 / 未知工具名 / 工具面求解不了)。 */
  const summaryBad = issues > 0 || found?.toolsSolved === false;

  /**
   * 卡片头的状态摘要 —— **三种「不知道」与「真的没有」在这里也必须分得开**。
   * 读不到 / 还在读 / 视图里没有这个角色,三句话各不相同,也都不许长得像
   * 「0 个单元、0 个工具」那种「一切正常」。
   */
  const unknownSummary =
    error !== null
      ? "状态摘要读不到(harness 视图加载失败)"
      : loading && view === null
        ? "正在读取 harness 视图…"
        : view === null
          ? "读不到 harness 视图"
          : `这一份 harness 视图里没有角色 ${role}`;

  return (
    <Section
      // 卡片头一行 = **标题 + 角色名 + 告警 Pill**。角标数字来自 `roleIssueCount`,
      // **只在 > 0 时**带上 —— 0 处时写一个「0 处需要注意」等于把「没问题」也刷成
      // 一条要读的字。
      title="角色 harness"
      hint={ROLE_LABEL[role]}
      // 「未来角色的 harness 配置就放在这里」这件事写在悬停里(用户原话),
      // 连「什么能改、什么改不了」一起说清 —— 否则用户会去找一个不存在的开关。
      helpId="harness.card"
      aside={
        <div className="flex items-center gap-1.5">
          {issues > 0 && (
            <Pill
              tone="cinnabar"
              title={`harness 有 ${issues} 处要注意 —— 与成员页签角标同源`}
            >
              {issues} 处需要注意
            </Pill>
          )}
          {/* 入口:跨角色的「Harness 管理」页(2026-11-14)。⚠️ 真 `<a href>`(地址由
              `toHash` 序列化,不手拼)—— 右键复制 / 中键开新标签 / 浏览器后退三件
              全靠它;带当前角色参数,过去就落在这个角色上。 */}
          <a
            className="sansheng-button"
            style={{ padding: "3px 8px", fontSize: 11 }}
            href={toHash(toRoute("harness", { role }))}
          >
            打开 Harness 管理 →
          </a>
        </div>
      }
    >
      <article className="sansheng-card p-3 flex flex-col gap-3">
        {/* 卡片头的**状态摘要行** —— 刻意放在 `<details>` **外面**:用户不展开
            这张卡就应该知道这个角色的 harness 正不正常(单元 x/y · 能力 n 项 ·
            实得工具 m 个 · 集合文件状态)。展开后的面板摘要行是同一批数的详细形态
            (逐项 tooltip + 「可写 N 类」),两处的数都来自同一个 `role` 对象。 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {found === null ? (
            <span className="ss-meta" style={{ color: "var(--bone-dim)" }}>
              {unknownSummary}
            </span>
          ) : (
            <span
              className="ss-meta"
              style={{ color: summaryBad ? "var(--cinnabar)" : "var(--bone-dim)" }}
              title="口径见展开后的各节 · 工具数不是能力的分数"
            >
              {harnessStatusText(found)}
            </span>
          )}
        </div>

        {/* 可编辑的配置**默认折叠**:提示词单元编辑器 / 工具集合文件 / 常量。 */}
        <Disclosure summary="展开配置(提示词单元 · 工具面 · 常量)" defaultOpen={defaultOpen}>
          {/*
            ⚠️ 三种「不知道」必须与「真的没有」分得开:`getHarness` 失败是**读不到**,
            不能说成「这个角色没有单元」。
            ⚠️ 这里**不套** `sansheng-card`:它已经在卡片本体的 `article` 里了,
            再套一层就是卡片套卡片(这一刀要清掉的正是嵌套的壳)——
            ⇒ `variant="inline"` 就是为这种场合留的。
          */}
          <DataState
            what="harness 视图"
            state={remoteOf(view, error, loading && view === null)}
            variant="inline"
            errorLabel="加载失败"
            errorNote=" —— 这是「读不到 harness 视图」,不是「这个角色没有提示词单元」。"
            loadingLabel="正在读取 harness 视图…"
            unavailable="读不到 harness 视图。"
          >
            {(view) => (
              found === null ? (
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
              {/* `embedded`:外层卡片头已经承担了标题与角色名,里层不再画自己的
                  `Section` 外壳(否则展开后是卡片套卡片、角色名出现两次)。 */}
              <HarnessRolePane
                embedded
                role={found}
                owners={owners}
                drafts={drafts}
                backups={backups}
                onDraftChange={onDraftChange}
                onApplied={onApplied}
              />
            </>
              )
            )}
        </DataState>
        </Disclosure>
      </article>
    </Section>
  );
}

/**
 * 成员页里**单独一张卡**的「角色 harness」—— **自足**:自己取整份 harness 视图,
 * 自己持有草稿与备份份数,自己按 unit id 应用保存 / 恢复的**回读值**。
 *
 * 2026-10-06(第三刀):它从 `MemberPane` **里面**搬到了**下面**(用户原话:
 * 「成员中,角色 harness 单独放一个卡片出来,未来角色的 harness 配置就放在这个
 * 地方」)。所以它不再是「某个成员面板的第五块」,而是**这个角色**配置面的落点;
 * 调用点见 `routes/Members.tsx`。
 *
 * ⚠️ 2026-11-14:取数 / 草稿 / 备份份数 / 回读值入口这层**有状态的东西**搬去了
 * `harness/useHarnessWorkspace.ts`(管理页共用同一个 hook);这里只剩组合
 * (hook ⇒ `RoleHarnessDisclosure`)。`onHarnessSaved` 的语义不变:页面用它把
 * `useHarnessRoles({ revision })` 推一格,让页签角标跟上刚保存的内容。
 */
export function RoleHarnessSection({
  role,
  defaultOpen = false,
  onHarnessSaved,
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
  onHarnessSaved?: () => void;
}) {
  const ws = useHarnessWorkspace({ onApplied: onHarnessSaved });
  return (
    <RoleHarnessDisclosure
      role={role}
      view={ws.view}
      loading={ws.loading}
      error={ws.error}
      drafts={ws.drafts}
      backups={ws.backups}
      defaultOpen={defaultOpen}
      onDraftChange={ws.onDraftChange}
      onApplied={ws.applyContent}
    />
  );
}
