/**
 * `DataState` —— 一个数据槽的**四种状态**只有一条写法
 *
 * ── 它治的是什么病 ────────────────────────────────────────────────
 *
 * 这套界面里同一个读面在四页上曾是四段手写三元表达式,而**顺序写反一次**就会把
 * 「读不到」显示成「没有」。真机踩过的三个具体形态(都在 `AGENTS.md` 里):
 *
 *   - `ProjectLiveView.runtime === "unavailable"` 被渲染成「空闲」(读不到 ≠ 空闲);
 *   - 「还没查过」与「查过了是 0 条」长成同一个空态(慢请求 = 数据不存在);
 *   - `knowledge` 的 `runtime: unavailable` 被显示成「0 条语料」。
 *
 * 三者的共同形状:**判据是写在 JSX 里的三元链,而不是一个可穷举的类型**。
 * 所以这里把状态收成一个判别联合,把「加载 / 读不到 / 有数据」三支**写死在一处**:
 * 没有数据就**拿不到** `children`,想「顺手渲染成空」在类型上就写不出来。
 *
 * ⚠️ **「空」刻意不在这里** —— 空态文案是领域语言(「这个项目还没有成员」还是
 * 「没有等你回答的问题」),由调用点在 `children` 里自己说。这里只负责回答
 * 「到底有没有拿到数据」这一个问题。
 *
 * ⚠️ **文案里的 `加载失败:` / `加载中…` 是既有断言钉住的**(`tests/web/acceptance-dock.test.ts`
 * 的 `toContain("加载失败:boom")` / `toContain("加载中…")`)。改文案要先确认那些判据
 * 还成立 —— 那两条测的是「错误原文必须上屏」,不是措辞。
 */
import type { ReactNode } from "react";
import { EmptyState } from "./primitives";

/**
 * 一个读面的状态。**四种,而且必须可分**:
 * `loading`(还没拿到)/ `error`(拿失败)/ `unavailable`(查完了但读不到)/ `ready`。
 * ⚠️ `unavailable` 不许并进 `ready`(会变成「没有」),也不许并进 `loading`(会永远转圈)。
 * 这条与 `ProjectLiveView.runtime === "unavailable"` 同源。
 */
export type RemoteState<T> =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "unavailable" }
  | { kind: "ready"; data: T };

/** 可空的单值读面。`data === null` 且没出错时,靠 `loading` 分开后两种。 */
export function remoteOf<T>(data: T | null, error: string | null, loading: boolean): RemoteState<T> {
  if (error !== null) return { kind: "error", error };
  if (data !== null) return { kind: "ready", data };
  if (loading) return { kind: "loading" };
  return { kind: "unavailable" };
}

/**
 * 列表读面。列表天生有「空数组」这个值,所以 `loading` 必须**显式**传:
 * 首帧的 `[]` 是「还没查到」,第二次拉取后的 `[]` 才是「真的没有」。
 * ⚠️ 这正是 `loading && rows.length === 0` 那条既有约定的类型化形态 ——
 * 调用点不要再自己拼这个判断。
 */
export function remoteListOf<T>(
  rows: readonly T[],
  loading: boolean,
  error: string | null,
): RemoteState<readonly T[]> {
  if (error !== null) return { kind: "error", error };
  if (loading && rows.length === 0) return { kind: "loading" };
  return { kind: "ready", data: rows };
}

export interface DataStateProps<T> {
  /** 这块数据叫什么(「成员」「运行态」「对话内容」)—— 用在两句提示里。 */
  what: string;
  state: RemoteState<T>;
  /** 外观:侧栏小字(`note`)还是主区空态卡(`empty`,默认)。 */
  variant?: "note" | "empty";
  /** 「查完了但读不到」那一档自己说(默认「读不到这块数据。」)。 */
  unavailable?: string;
  /** **只有拿到了数据**才会被调用 —— 空态文案也在里面自己说(见文件头)。 */
  children: (data: T) => ReactNode;
}

export function DataState<T>({
  what,
  state,
  variant = "empty",
  unavailable,
  children,
}: DataStateProps<T>) {
  if (state.kind === "error") {
    const message = `加载失败:${state.error}`;
    return variant === "note" ? (
      <div className="ss-meta" style={{ color: "var(--cinnabar)" }}>
        {message}
      </div>
    ) : (
      <div className="ss-empty" style={{ color: "var(--cinnabar)" }}>
        {message}
      </div>
    );
  }
  if (state.kind === "loading") {
    const message = `${what}加载中…`;
    return variant === "note" ? <div className="ss-meta">{message}</div> : <EmptyState>{message}</EmptyState>;
  }
  if (state.kind === "unavailable") {
    const message = unavailable ?? `读不到${what}。`;
    return variant === "note" ? <div className="ss-meta">{message}</div> : <EmptyState>{message}</EmptyState>;
  }
  return <>{children(state.data)}</>;
}
