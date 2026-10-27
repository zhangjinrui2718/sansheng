/**
 * 「项目坐标」—— 地址里的 `?project=` 是**这条地址说的是哪个项目**
 *
 * ── 它治的是什么病 ────────────────────────────────────────────────
 *
 * 这个应用里的实体大半是**项目级**的(工件、工作项、成员、阻塞、语料块),
 * 而「当前项目」是应用里的一处**全局选择**(store 的 `projectId`)。
 * 于是有一类地址是**半个地址**:
 *
 *   `#/works?artifact=art_7`
 *
 * 它只在「你正好在看它所属的那个项目」时才指对 —— 而链接的用处恰恰是
 * **从别处跳过来**。跳过去若落在别的项目,读者看到的是「点得动、跳得过去、
 * 就是找不到」,而链接**看起来完全正常**。
 *
 * ⇒ 跨项目指过去的地址必须**带上项目**:`#/works?project=p_2&artifact=art_7`。
 *
 * ── `?project=` 是什么(三条纪律) ─────────────────────────────────
 *
 * 1. **坐标,不是状态** —— 它回答「这条地址说的是哪个项目」,
 *    **不**回答「你现在在看哪个项目」(那件事只住在 store 里)。
 *    ⇒ 所以它**不会**跟着页面导航自动出现,也**不该**在每个地址里都躺着。
 * 2. **落地时生效** —— 读到它与当前项目不同,就切到那个项目。
 * 3. **坐标会过期** —— 用户随后自己切了项目,地址里的坐标就指错了地方。
 *    ⇒ 那时**清掉它**(而不是让它继续生效,也不是让它把用户拽回去)。
 *
 * ⚠️ **踩过的坑:坐标会「打架」** —— 改版前 `routes/ProjectDetail.tsx` 有一个
 * 自己的 `?project=` 效果:它每次渲染都看地址里的项目,不等当前项目,
 * 就切过去。于是**用户从左栏切了项目**(地址没变)⇒ 那个效果又把他拽回去
 * ⇒ 「切项目」这个动作被撤销,而症状是「点左栏没反应」。
 * ⇒ 现在这个判断**只有一处**(`useProjectCoordinate`),而且**坐标过期就清掉**
 * —— 清掉之后,「用户切了项目」与「地址点名了某个项目」不再互相撤销。
 *
 * ── 为什么判据是纯函数 ────────────────────────────────────────────
 *
 * 这个 hook 要做的事有三条走法(切 / 不切 / 清坐标),每一条都出过事。
 * ⇒ 判据写成**纯函数** `decideCoordinate`(可直接单测),hook 只是薄壳。
 */
import { useEffect, useRef } from "react";
import { useChatStore } from "@/stores/chat";
import { paramOf, useAppLocation } from "./route";

/**
 * 「地址里的项目坐标」该不该切项目。**纯函数**。
 *
 * @param wanted 地址里的 `?project=`(没有 = `null`)
 * @param currentProjectId 当前项目(store)
 * @param knownProjectIds 已知项目 id。**空数组 = 列表还没读到**,
 *   那时**不**据此判「地址指向不存在的项目」(列表没到 ≠ 项目不存在)。
 * @param lastApplied 已经按地址切过的那个项目(`null` = 没切过)
 */
export function shouldApplyProjectCoordinate(
  wanted: string | null,
  currentProjectId: string | null,
  knownProjectIds: readonly string[],
  lastApplied: string | null,
): boolean {
  if (wanted === null) return false;
  // 已经在看它了 —— 什么都不用做。
  if (wanted === currentProjectId) return false;
  // ⚠️ **这个坐标已经用过了** —— 地址没变而项目被换掉,那是用户自己的动作,
  // 地址里的坐标是**上一次**留下的,不能再拿它切回去。
  if (lastApplied === wanted) return false;
  // 列表读到了、而地址点名的项目不在里面 ⇒ 那是**指向空气的地址**。
  // 不切:切过去只会得到一个空项目,而症状是「应用坏了」。
  if (knownProjectIds.length > 0 && !knownProjectIds.includes(wanted)) return false;
  return true;
}

// ── 完整决策(纯函数,hook 只是薄壳)───────────────────────────────

/** 坐标机制自己的记据:已经按地址切过的那个项目。 */
export interface CoordinateState {
  readonly applied: string | null;
}

export interface CoordinateInput {
  /** 地址里的 `?project=`。 */
  readonly wanted: string | null;
  /** 当前项目(store)。 */
  readonly projectId: string | null;
  /** 已知项目 id(空数组 = 列表还没读到)。 */
  readonly known: readonly string[];
}

export interface CoordinateDecision {
  /** 下一轮的记据。 */
  readonly state: CoordinateState;
  /** 要切到哪个项目(`null` = 不切)。 */
  readonly switchTo: string | null;
  /** 要不要把地址里的坐标清掉。 */
  readonly clear: boolean;
}

export const INITIAL_COORDINATE_STATE: CoordinateState = { applied: null };

/**
 * 「地址里的项目坐标」现在该怎么办。**纯函数** —— 三条走法:
 *
 * | 现场 | 动作 |
 * |---|---|
 * | 项目被别人改了(不是我们改的)⇒ 坐标过期 | **清掉地址里的坐标** |
 * | 地址点名了另一个项目 | 切过去 |
 * | 已经在看它 / 地址没有坐标 | 什么都不做 |
 *
 * ⚠️ **第一条是「切项目」与「地址点名」不再互相撤销的关键**:
 * 不清掉的话,下一次任何导航(哪怕那个导航保留了 `?project=`)都会把用户
 * 拽回上一个项目,而症状是「切了项目又跳回去」。
 */
export function decideCoordinate(
  state: CoordinateState,
  input: CoordinateInput,
): CoordinateDecision {
  const { wanted, projectId, known } = input;

  // ① **坐标过期**:项目被换成了不是我们切过去的那个 ⇒ 是用户自己的动作
  //    ⇒ 地址里的坐标指错了地方 ⇒ 清掉它。
  if (state.applied !== null && projectId !== state.applied) {
    return { state: { applied: null }, switchTo: null, clear: true };
  }

  // ② 地址里没有坐标 ⇒ 没什么要落的(记据也清掉:下一次带坐标的地址是「新的」)。
  if (wanted === null) {
    return { state: { applied: null }, switchTo: null, clear: false };
  }

  // ③ 已经在看它 ⇒ 什么都不做,但**记下这个坐标用过了**
  //    (否则下一次任何渲染都会重新判「要不要切」,而答案必须是「不要」)。
  if (wanted === projectId) {
    return { state: { applied: wanted }, switchTo: null, clear: false };
  }

  // ④ 切过去。
  if (!shouldApplyProjectCoordinate(wanted, projectId, known, state.applied)) {
    return { state, switchTo: null, clear: false };
  }
  return { state: { applied: wanted }, switchTo: wanted, clear: false };
}

/**
 * 把地址里的项目坐标落到 store 上。**整个应用只挂一次**(`App.tsx`)——
 * 多处挂就会有多份「切过了哪个」的记据,于是互相打架。
 */
export function useProjectCoordinate(): void {
  const { loc, setParam } = useAppLocation();
  const projectId = useChatStore((s) => s.projectId);
  const projects = useChatStore((s) => s.projects);
  const selectProject = useChatStore((s) => s.selectProject);
  const wanted = paramOf(loc, "project");
  const state = useRef<CoordinateState>(INITIAL_COORDINATE_STATE);

  useEffect(() => {
    const decision = decideCoordinate(state.current, {
      wanted,
      projectId,
      known: projects.map((p) => p.id),
    });
    // ⚠️ **先更新记据,再动作** —— `selectProject` 会同步改 store,
    // 下一轮 effect 读到的必须是「已经切过了」。
    state.current = decision.state;
    if (decision.clear) setParam("project", null);
    if (decision.switchTo !== null) void selectProject(decision.switchTo);
  }, [wanted, projectId, projects, selectProject, setParam]);
}
