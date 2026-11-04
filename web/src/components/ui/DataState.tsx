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
import { EmptyState, RedCard, RedEmpty, RedInline, RedNote } from "./primitives";

/** 一个读面的状态 —— **没有第四种**:要么没拿到、要么拿失败、要么拿到了。 */
export type RemoteState<T> =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "unavailable" }
  | { kind: "ready"; data: T };

/**
 * 可空的单值读面。`data === null` 且没出错时,靠 `loading` 分开后两种。
 *
 * ⚠️ **判据的顺序是判据的一部分**:`data !== null` 先判 ——
 * 那样「刷新中但手里有旧数据」显示的是**旧数据**,而不是「加载中…」。
 * (反过来会把一次后台刷新说成「读不到」,而且旧数据会被藏起来。)
 */
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

/**
 * 外观 —— **每一种都有读者**(判据在 `tests/web/data-state.test.ts`:
 * 「每个 variant 至少被用一次」—— 没人用的 variant 就是第二份事实来源)。
 *
 * - `empty`(默认)—— 空态卡:错误那一支用 `ss-empty`,另两支用 `<EmptyState>`;
 * - `note` —— 正文小字(`ss-note`,11px):错误与提示都走这一种;
 * - `card` —— **错误那一支**渲染成卡片(`sansheng-card p-3 text-xs`),
 *   另两支用 `<EmptyState>`。
 *   ⚠️ 为什么要这一种:错误那一支原先在十几个地方各写一遍卡片样式,
 *   收进来若只给 `ss-empty`,页面会**掉一层壳**(视觉变了),而
 *   「收口」不该顺手改外观;
 * - `inline` —— 错误那一支是**无壳小字**(`p-2 text-xs`):
 *   给「已经在卡片里」的场合(再套一层卡片就是卡片套卡片)。
 *
 * ⚠️ **没有 `meta`**(2026-10-27):原来有,写文档时看着合理,落地后**一个读者都没有**
 * ⇒ 「没人用的 variant 就是第二份事实来源」(它长得能用,于是会有人用)
 * ⇒ 删掉。红字等宽小字那一种归 `ui/primitives.tsx` 的 `RedMeta`
 * (成员页首的「运行态读取失败」用它)。
 *
 * ⚠️ **外壳本身不在这里定义** —— 红色的四种壳归 `ui/primitives.tsx`
 * (`RedNote` / `RedMeta` / `RedCard` / `RedEmpty`):这里只管**判据**。
 */
export type DataStateVariant = "empty" | "note" | "card" | "inline";

/**
 * 错误那一支的**外壳** —— 只有一处。
 *
 * ⚠️ **为什么单独导出**:有一批读面只显示错误(它读的那一面是**别的**组件的事),
 * 那一支不必套 `<DataState>`。若让它们各写一遍 `sansheng-card p-3 text-xs` +
 * 朱色,错误壳就有第二份 ⇒ 改样式时只改得动一半。
 */
export function ReadError({
  error,
  label = "加载失败",
  note,
  variant = "empty",
  title,
}: {
  error: string;
  /**
   * 错误那一支的前缀。
   * ⚠️ **传空串 = 不要前缀** —— 有的读面原来就只印错误原文
   * (不想要「加载失败:」这四个字),那也是**领域词**,
   * 但**拼法只有这一处**。
   */
  label?: string;
  note?: string;
  variant?: DataStateVariant;
  title?: string;
}) {
  const prefix = label === "" ? "" : `${label}:`;
  const message = `${prefix}${error}${note ? note : ""}`;
  if (variant === "note") return <RedNote title={title}>{message}</RedNote>;
  if (variant === "card") return <RedCard title={title}>{message}</RedCard>;
  if (variant === "inline") return <RedInline title={title}>{message}</RedInline>;
  return <RedEmpty title={title}>{message}</RedEmpty>;
}

export interface DataStateProps<T> {
  /** 这块数据叫什么(「成员」「运行态」「对话内容」)—— 用在两句提示里。 */
  what: string;
  state: RemoteState<T>;
  /** 外观(见 `DataStateVariant`)。 */
  variant?: DataStateVariant;
  /** 「查完了但读不到」那一档自己说(默认「读不到这块数据。」)。 */
  unavailable?: string;
  /**
   * 错误那一支的前缀(默认「加载失败」)。
   * ⚠️ **为什么留这个口子**:有的读面说「读不到用量」比「加载失败」准确
   * (那不是「请求失败」,是「这一项读不到」)。**前缀是领域词**,
   * 但**只有一处默认** ⇒ 拼法仍由这一处给。
   */
  errorLabel?: string;
  /** 追加在错误后面的一句(默认无)。有的读面要补「这不是『没有』」这种区分。 */
  errorNote?: string;
  /** 「加载中」那一支自己说(默认「{what}加载中…」)。 */
  loadingLabel?: string;
  /** **只有拿到了数据**才会被调用 —— 空态文案也在里面自己说(见文件头)。 */
  children: (data: T) => ReactNode;
}

export function DataState<T>({
  what,
  state,
  variant = "empty",
  unavailable,
  errorLabel = "加载失败",
  errorNote,
  loadingLabel,
  children,
}: DataStateProps<T>) {
  if (state.kind === "error") {
    return <ReadError error={state.error} label={errorLabel} note={errorNote} variant={variant} />;
  }
  if (state.kind === "loading") {
    const message = loadingLabel ?? `${what}加载中…`;
    return variant === "note" ? (
      <div className="ss-note">{message}</div>
    ) : (
      <EmptyState>{message}</EmptyState>
    );
  }
  if (state.kind === "unavailable") {
    const message = unavailable ?? `读不到${what}。`;
    return variant === "note" ? (
      <div className="ss-note">{message}</div>
    ) : (
      <EmptyState>{message}</EmptyState>
    );
  }
  return <>{children(state.data)}</>;
}
