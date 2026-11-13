/**
 * `overdue_asks` 的**前端读者**(2026-11-13)
 *
 * ── 为什么要有这份测试 ──────────────────────────────────────────
 *
 * 这条事件曾经是一条断头路:调度器每 60s 扫、变化时真的在广播,契约类型也在,
 * 但前端 `applyEvent` 的 switch 里没有这个 case —— 信号发出来就掉在地上,
 * 界面上唯一的「读者」是一句注释。接上之后,这里钉住它的消费语义:
 *
 *   · 当前项目 ⇒ `projectRevision` + `projectsRevision` 都推 —— 内部协作列表
 *     (`useProjectAsks` 读的是 `projectRevision`)与左栏徽标都要重拉;
 *   · 别的项目 ⇒ 只推 `projectsRevision`(左栏徽标该动,当前项目详情不该重拉
 *     —— 与 `client_question` 同一条分寸);
 *   · **不动 `activityRevision`** —— 谁在跑与超时无关,运行态不该被它刷。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../../web/src/stores/chat.js";

const P = "p-overdue";

beforeEach(() => {
  useChatStore.setState({
    projectId: P,
    projectRevision: 0,
    projectsRevision: 0,
    activityRevision: 0,
  });
});

function fire(projectId: string): void {
  useChatStore.getState().applyEvent({
    type: "overdue_asks",
    projectId,
    askIds: ["ask_1", "ask_2"],
    count: 2,
  });
}

describe("overdue_asks:断头路接上之后的消费语义", () => {
  it("① 当前项目 ⇒ projectRevision 与 projectsRevision 都推一格", () => {
    fire(P);
    const s = useChatStore.getState();
    expect(s.projectRevision).toBe(1);
    expect(s.projectsRevision).toBe(1);
    expect(s.activityRevision).toBe(0);
  });

  it("② 别的项目 ⇒ 只推 projectsRevision(当前项目详情不该重拉)", () => {
    fire("p-其他");
    const s = useChatStore.getState();
    expect(s.projectRevision).toBe(0);
    expect(s.projectsRevision).toBe(1);
    expect(s.activityRevision).toBe(0);
  });
});
