/**
 * 「整份 harness 视图 + 草稿 + 备份数」这一层**有状态的工作台**
 * (2026-11-14 从 `components/members/RoleHarness.tsx` 的 `RoleHarnessSection`
 * 里搬出)。
 *
 * ── 为什么要搬 ──────────────────────────────────────────────────
 *
 * 「Harness 管理」页(`routes/HarnessManage.tsx`)与成员页的「角色 harness」卡
 * 需要的是**同一份有状态的东西**:整份 `GET /api/harness`(必须要整份:
 * `sharedUnitOwners` 要跨角色才知道「共用于几个角色」)+ 按 unit id 存的草稿 +
 * 每个单元的备份份数 + 「保存 / 恢复成功后用**回读值**当新状态」的唯一入口。
 * 两个页面各持一份的话,写面规矩(回读值当状态、备份刷新)必然漂开。
 *
 * 行为与 `RoleHarnessSection` 原来的逐字相同(判据见
 * `tests/web/harness-by-role.test.ts`):
 *   - 它自己取数而不是复用 `lib/data.ts` 的 `useHarnessRoles()`(模块级缓存只给
 *     roles,这里要整份 `HarnessView` —— strayToolSetFiles 也在里面)。**已知代价**
 *     与原来一样:面板自取 ⇒ 成员页页签角标那一份要靠 `onApplied` 推 revision 才跟上。
 *   - `applyContent` 只吃后端**回读**的正文(写面规矩③:报成功 = 真生效);
 *     保存后刷新该单元的备份数。
 *   - 新增一条(管理页需要):`applyContent` 成功后**失效标签页级缓存**
 *     (`invalidateHarnessCache`)—— 盘上的正文变了,成员页页签角标与对话页的
 *     「面向甲方」判据下次读取时必须拿到新状态,而不是缓存里的旧响应。
 *     对成员页那条链路无行为变化(`onApplied` 推的 revision 本来就会再失效一次)。
 */
import { useCallback, useEffect, useState } from "react";
import type { HarnessView } from "@shared/types/platform";
import { errorMessage, getHarness, listPromptUnitBackups } from "@/lib/api";
import { invalidateHarnessCache } from "@/lib/data";

export interface HarnessWorkspace {
  /** 整份视图;`null` = 还没拿到(loading / unavailable 由 error 与 loading 区分) */
  view: HarnessView | null;
  loading: boolean;
  /** 取数失败的原文;`null` = 没失败 */
  error: string | null;
  /** 编辑中的正文,**按 unit id 存**(同一个单元被多个角色声明时共用一份草稿) */
  drafts: Record<string, string>;
  /** 每个单元的备份份数。`-1` = 查不到(如实显示成「—」,不显示 0)。 */
  backups: Record<string, number>;
  onDraftChange: (unitId: string, next: string) => void;
  /** 保存 / 恢复成功 —— 参数只有 `content`,也就是后端回读的那一份。 */
  applyContent: (unitId: string, content: string) => void;
}

export function useHarnessWorkspace(options?: {
  /** 一次保存 / 恢复**成功之后**通知调用方(成员页用它推页签角标的 revision)。 */
  onApplied?: () => void;
}): HarnessWorkspace {
  const onApplied = options?.onApplied;
  const [view, setView] = useState<HarnessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
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
      // 盘上的正文变了 ⇒ 丢掉标签页级缓存,别的读者(成员页页签角标、对话页的
      // clientFacing 判据)下次挂载时才会重取。
      invalidateHarnessCache();
      onApplied?.();
    },
    [refreshBackups, onApplied],
  );

  const onDraftChange = useCallback((unitId: string, next: string) => {
    setDrafts((d) => ({ ...d, [unitId]: next }));
  }, []);

  return { view, loading, error, drafts, backups, onDraftChange, applyContent };
}
