/**
 * 「自己的工具与经验」折叠块的**有状态**那一层(migration 040,2026-11-28)
 *
 * ── 它自己取数,不复用整份 harness 视图 ─────────────────────────
 *
 * 成员页那张卡已经取过一整份 `GET /api/harness`(其中 `roles[].own` 是同一份内容的
 * 快照,用在折叠块的标题上);但**停用 / 恢复 / 删除之后要重读** —— 为一个折叠块
 * 重取整份 harness 视图不划算,所以这里走 `GET /api/harness/own/:role`。
 * 动作成功之后仍然做两件事:失效标签页级缓存(`invalidateHarnessCache`)、通知页面
 * (`onChanged`)—— 卡片头那份快照下次挂载时才会跟上。
 *
 * ── 四态走 `DataState` ────────────────────────────────────────
 *
 * 读不到 ≠ 没有:两块读面各自一个 `RemoteState`。动作失败(停用 / 恢复 / 删除)单独
 * 一行 `actionError` —— 它不属于任何一块读面,却必须上屏。
 *
 * ⚠️ 检索**只在提交时发请求**(`query` 是提交过的那个,输入框里的字是另一个 state):
 * 每敲一个字母打一次后端,既浪费也会让结果闪。
 */
import { useCallback, useEffect, useState } from "react";
import type { AgentNoteView, OwnKitView, ProjectRole } from "@shared/types/platform";
import { deleteOwnNote, errorMessage, getOwnKit, listOwnNotes, setOwnToolDisabled } from "@/lib/api";
import { invalidateHarnessCache } from "@/lib/data";
import { remoteListOf, remoteOf, type RemoteState } from "@/components/ui/DataState";

export interface OwnKitModel {
  /** 仓库位置 + 工具清单 + 经验库计数。 */
  readonly state: RemoteState<OwnKitView>;
  /** 经验条目(按提交过的检索词)。 */
  readonly notes: RemoteState<readonly AgentNoteView[]>;
  /** 输入框里的字(还没提交)。 */
  readonly input: string;
  readonly setInput: (next: string) => void;
  /** 提交检索;传空串 = 回到「最近条目」。 */
  readonly submitSearch: (q: string) => void;
  /** 最近一次动作失败的原文;`null` = 没失败。动作成功时清掉。 */
  readonly actionError: string | null;
  /** 停用 / 恢复一条工具。失败不抛 —— 原文进 `actionError`。 */
  readonly toggle: (name: string, disabled: boolean) => Promise<void>;
  /** 删一条经验。失败不抛 —— 原文进 `actionError`。 */
  readonly removeNote: (id: string) => Promise<void>;
}

export function useOwnKit(
  role: ProjectRole,
  /** 折叠块展开着才取数(收起时不发请求)。 */
  active: boolean,
  opts: { onChanged?: () => void } = {},
): OwnKitModel {
  const onChanged = opts.onChanged;
  const [own, setOwn] = useState<OwnKitView | null>(null);
  const [ownError, setOwnError] = useState<string | null>(null);
  const [ownLoading, setOwnLoading] = useState(false);
  const [rows, setRows] = useState<AgentNoteView[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  /** 一次成功动作之后的重取代数。 */
  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setOwnLoading(true);
    getOwnKit(role)
      .then((r) => {
        if (!alive) return;
        setOwn(r.own);
        setOwnError(null);
        setOwnLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setOwn(null);
        setOwnError(errorMessage(e));
        setOwnLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [role, active, rev]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setNotesLoading(true);
    listOwnNotes(role, query)
      .then((r) => {
        if (!alive) return;
        setRows(r.notes);
        setNotesError(null);
        setNotesLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setRows(null);
        setNotesError(errorMessage(e));
        setNotesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [role, active, rev, query]);

  /** 一次成功动作之后:重读两块读面、失效标签页级缓存、通知页面。 */
  const afterAction = useCallback(() => {
    setActionError(null);
    setRev((r) => r + 1);
    invalidateHarnessCache();
    onChanged?.();
  }, [onChanged]);

  const toggle = useCallback(
    async (name: string, disabled: boolean): Promise<void> => {
      try {
        await setOwnToolDisabled(role, name, disabled);
        afterAction();
      } catch (e: unknown) {
        setActionError(errorMessage(e));
      }
    },
    [role, afterAction],
  );

  const removeNote = useCallback(
    async (id: string): Promise<void> => {
      try {
        await deleteOwnNote(role, id);
        afterAction();
      } catch (e: unknown) {
        setActionError(errorMessage(e));
      }
    },
    [role, afterAction],
  );

  return {
    state: remoteOf(own, ownError, ownLoading),
    notes: remoteListOf(rows ?? [], notesLoading, notesError),
    input,
    setInput,
    submitSearch: setQuery,
    actionError,
    toggle,
    removeNote,
  };
}
