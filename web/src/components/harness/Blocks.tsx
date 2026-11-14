/**
 * harness 面板的**工具面 / 代码内常量 / 告警**三个段落(2026-11-14 从
 * `components/members/RoleHarness.tsx` 的 `HarnessRolePane` 里搬出)。
 *
 * ── 为什么搬 ─────────────────────────────────────────────────────
 *
 * 「Harness 管理」页(`routes/HarnessManage.tsx`)的右列②③两段与成员页面板
 * 的折叠块④是**同一批事实**:实得工具数 / 集合文件状态与路径 / 越权被拒清单 /
 * ceiling·writeKinds·boundaryDeny。事实只有一个来源(`GET /api/harness`),
 * 读法与措辞也只有一份 —— 搬到这里让两个页面共用,谁也不许另写一套
 * 「文件无效 / 超出架构上界」。
 *
 * 逐字搬来的判据(`tests/web/harness-by-role.test.ts` 判据 ④⑤⑩ 钉着):
 *   - 四类告警(缺单元 / 集合文件坏 / 越权被拒 / 未知工具名)**一条都不静默**;
 *   - 「求解不了」不许说成「0 个」(`toolCountText`,判据在 judgments.ts);
 *   - 工具表是类型 / 名称 / 作用三列(`ToolTable`);briefs 缺席退化回英文名单,
 *     **不许**显示成「没有工具」;
 *   - `ceiling` / `writeKinds` / `boundaryDeny` 标注「代码内常量,改不了」——
 *     不标注用户会去找一个不存在的开关(RoleHarness 文件头的规矩③)。
 */
import type { RoleHarnessView } from "@shared/types/platform";
import { Flag, KV } from "@/components/ui/primitives";
import { Help } from "@/components/ui/Help";
import { ToolTable } from "@/components/members/ToolTable";
import { toolCountText, toolSetStateDetail } from "@/components/harness/judgments";

/**
 * 缺失单元的那条告警。**独立成组件**是因为它在两个页面的落点不同
 * (成员页在告警区,管理页在「提示词单元」段),但事实与措辞必须是同一份。
 */
export function MissingUnitsAlert({ missing }: { missing: RoleHarnessView["promptUnits"] }) {
  if (missing.length === 0) return null;
  return (
    <Flag tone="cinnabar">
      <span className="ss-meta">
        有 {missing.length} 个单元声明了但盘上没有文件 —— 这几条职责从没告诉过 agent:
      </span>
      <span className="ss-body">{missing.map((u) => u.id).join(" · ")}</span>
    </Flag>
  );
}

/**
 * 集合文件与越权相关的**四条告警**(集合文件坏 / 超出架构上界 / 未知工具名 /
 * 被集合文件收掉)。红色在前、灰色在后 —— 顺序是判据的一部分(见成员页面板)。
 */
export function ToolSetAlerts({ role }: { role: RoleHarnessView }) {
  return (
    <>
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
    </>
  );
}

/**
 * 「工具面」段落:实得工具数 → 集合文件状态与路径 → 文件里的 allow / deny →
 * 工具明细表。管理页把它摊开(②),成员页把它折进 Disclosure(④)——
 * 同一个组件,两种摆法。
 */
export function ToolSurface({ role }: { role: RoleHarnessView }) {
  return (
    <div className="flex flex-col gap-0.5">
      <KV label="实得工具" value={toolCountText(role)} title="已过三道门 · 下表逐条给出类型 / 名称 / 作用">
        <Help id="harness.gates" />
      </KV>
      <KV
        label="集合文件"
        value={toolSetStateDetail(role)}
        title="只有 ok 会真的收窄工具面;其余按 ceiling 全集求解"
      />
      <KV label="路径" value={<span className="ss-meta font-mono">{role.toolSet.path}</span>} />
      {/* 集合文件本批无写面:用户直接编辑文件,界面只读呈现(出处见 harness.toolset)。 */}
      <div className="ss-note">集合文件直接编辑上面这个文件;界面不提供写面。</div>
      {/* allow / deny 是文件里的原名单,直接摆出来(旧版藏在悬停里);不再加悬停 ——
          名单本身可见,悬停只会把 title= 预算抬高。 */}
      {role.toolSet.allow.length > 0 && (
        <KV label="allow" value={role.toolSet.allow.join(" · ")} />
      )}
      {role.toolSet.deny.length > 0 && (
        <KV label="deny" value={role.toolSet.deny.join(" · ")} />
      )}
      {/* ⚠️ `toolBriefs` 缺席(旧后端)时**退化回老形状**那一串英文名,
          **不许**把「这一份读面没带说明」显示成「没有工具」—— 那与本项目反复
          栽的「把不知道显示成 0」是同一种错。 */}
      {role.toolBriefs !== undefined && role.toolBriefs.length > 0 ? (
        <ToolTable briefs={role.toolBriefs} />
      ) : role.tools.length > 0 ? (
        <KV
          label="工具名单"
          value={role.tools.join(" · ")}
          title="视图没带工具说明(后端比前端旧)· 只能给出名字"
        />
      ) : null}
    </div>
  );
}

/**
 * 「代码内常量」段落:能力(ceiling)/ 可写(writeKinds)/ 边界拒(boundaryDeny)。
 * 它们是 `ROLE_SPECS` 里的代码内常量,改它们要走代码评审(7-E)—— 每一行都
 * 标着「改不了」,不让用户去找一个不存在的编辑框。
 */
export function RoleConstants({ role }: { role: RoleHarnessView }) {
  return (
    <div className="flex flex-col">
      <KV
        label="能力"
        value={`${role.ceiling.length} 项 · 代码内常量,改不了`}
        title="架构上界 · 集合文件与界面都突破不了它"
      />
      <KV
        label="可写"
        value={`${role.writeKinds.join(" · ") || "不可写"} · 代码内常量,改不了`}
        title="代码内常量,不是可编辑文件 · 这里只能改提示词"
      />
      <KV
        label="边界拒"
        value={role.boundaryDeny.length > 0 ? role.boundaryDeny.join(" · ") : "—"}
        title="明示这个角色拿不到哪些工具。同样是代码内常量,这里改不了。"
      />
      <div className="flex flex-wrap gap-1" style={{ marginTop: 6 }}>
        {role.ceiling.map((c) => (
          <span key={c} className="ss-pill" data-tone="bone">
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}
