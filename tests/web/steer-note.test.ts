/**
 * 补话 · 前端(2026-11-25)· 回归
 *
 * ── 这个机制补的是什么 ──────────────────────────────────────────
 *
 * 后端能往正在跑的回合里补话(见 `tests/platform/steer.test.ts`),但界面上
 * 此前**够不着**:业务经理回答期间输入框是禁用的 —— 忙时排队(036)只有在
 * 刷新之后、或从别的对话线发话时才触发。现在:
 *
 *   ① 回答期间输入框**可发**(内部角色在跑不许锁输入框 —— bug A 的纪律原样保留);
 *   ② 状态行说清「现在发的话会补进这一轮」,且**只在补得进去的那一轮上说**
 *      (甲方亲自触发的回合、就在这条线上);别的轮不许冒充;
 *   ③ `message_steered` 提示行:与「已排队」互斥、回合收尾即过期、只在当前线上。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerEvent } from "@shared/types/platform";
import { ChatComposer } from "@/features/chat/ChatComposer";
import { useChatStore, type Turn } from "@/stores/chat";
import { PlatformSocket } from "@/lib/ws";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, getProjectLive: vi.fn(), getIntakeLive: vi.fn() };
});

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, "..", "..", rel), "utf8");

/** 只留**可见正文**:去掉标签(属性跟在一起一起走)与 SSR 插的 `<!-- -->`。 */
const visible = (html: string): string =>
  html.replace(/ title="[^"]*"/g, "").replace(/<!-- -->/g, "").replace(/<[^>]*>/g, "");

const P = "p1";
const MAIN = "s-main";
const THREAD = "s-thread";

/** 一条在飞的轮(建轮封套带 `trigger` —— `channelOf` 读它判通道)。 */
function liveTurn(over: Partial<Turn> = {}): Turn {
  return {
    id: "m1",
    projectId: P,
    sessionId: MAIN,
    role: "assistant",
    blocks: [{ kind: "text", text: "我正在查…" }],
    startedAt: 1_700_000_000_000,
    agentId: "bm",
    origin: { source: "turn", trigger: { kind: "user" } },
    ...over,
  } as Turn;
}

const note = (type: "message_steered" | "message_queued", projectId = P, sessionId = MAIN): ServerEvent =>
  ({ type, projectId, sessionId, messageId: "m-steer" });

beforeEach(() => {
  useChatStore.setState({
    projectId: P,
    intakeActive: false,
    sessionId: MAIN,
    turns: [],
    inFlight: {},
    inFlightOrder: [],
    currentTurn: null,
    lastUserEchoId: null,
    lastUserSend: null,
    queuedNote: null,
    steeredNote: null,
    status: "idle",
    socket: { sendToProject: () => true, send: () => true } as unknown as PlatformSocket,
    socketStatus: "open",
    error: null,
  });
});

// ── ③ store:提示行 ───────────────────────────────────────────────

describe("store · message_steered 提示", () => {
  it("当前项目、当前线 ⇒ 记下提示(渲染层据此显示「已补进当前这一轮」)", () => {
    useChatStore.getState().applyEvent(note("message_steered"));
    expect(useChatStore.getState().steeredNote).toEqual({
      projectId: P, sessionId: MAIN, messageId: "m-steer",
    });
  });

  it("与「已排队」互斥:同一句先报排队、后报补进 ⇒ 排队提示让位", () => {
    useChatStore.getState().applyEvent(note("message_queued"));
    expect(useChatStore.getState().queuedNote).not.toBeNull();
    useChatStore.getState().applyEvent(note("message_steered"));
    expect(useChatStore.getState().queuedNote, "补进去了就不该再说「已排队」").toBeNull();
    expect(useChatStore.getState().steeredNote).not.toBeNull();
  });

  it("负样本:别的项目的提示不记(别处的提示不该在这里冒一行)", () => {
    useChatStore.getState().applyEvent(note("message_steered", "p-other"));
    expect(useChatStore.getState().steeredNote).toBeNull();
  });

  it("那条线上一次 `agent_end` 即过期;别的线收口不动它", () => {
    useChatStore.getState().applyEvent(note("message_steered"));
    useChatStore.getState().applyEvent({ type: "agent_end", projectId: P, sessionId: THREAD, ts: 1 });
    expect(useChatStore.getState().steeredNote, "别的线的回合收口与这句话无关").not.toBeNull();
    useChatStore.getState().applyEvent({ type: "agent_end", projectId: P, sessionId: MAIN, ts: 2 });
    expect(useChatStore.getState().steeredNote, "这一轮结束了,提示不再描述现在").toBeNull();
  });
});

// ── ① 回答期间输入框可发 ────────────────────────────────────────

describe("回答期间输入框可发(此前被禁用 —— 排队只有刷新之后才够得着)", () => {
  it("store:甲方通道有在飞的轮时 `sendMessage` 照发(它从来没有 busy 闸,钉住这一点)", () => {
    const t = liveTurn();
    useChatStore.setState({ inFlight: { m1: t }, inFlightOrder: ["m1"] });
    expect(useChatStore.getState().sendMessage("等一下,需求改了")).toBe(true);
    // 那句话乐观上屏了(用户不会觉得它被吞了)。
    expect(useChatStore.getState().turns.some((x) => x.id.startsWith("u_"))).toBe(true);
  });

  it("页面:`send()` 不再因 `clientBusy` 拦,输入框的禁用也不再看它", () => {
    const src = read("web/src/features/chat/ChatSurface.tsx");
    // 剥注释后判 —— 判据那句话本身就写在注释里,不剥等于判据把自己判红。
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(stripped, "旧写法:甲方通道在跑就发不出去").not.toContain("!text || clientBusy ||");
    expect(stripped).toContain("if (!text || !hasKey || !hasContext) return false;");
    expect(stripped, "输入框的禁用只剩两档真实理由").toContain("disabled={!hasKey || !hasContext}");
    expect(stripped, "`reason` 里不该再有 streaming 那一档来自甲方通道在跑")
      .not.toMatch(/clientBusy\s*\?\s*"streaming"/);
  });

  it("输入框组件:对方正在回答时发送键可按、写着「发送」,不再是「推演中…」", () => {
    const html = visible(renderToStaticMarkup(createElement(ChatComposer, {
      value: "改需求",
      onChange: () => undefined,
      onSubmit: () => true,
      onInterrupt: () => undefined,
      interruptible: true,
      steerable: true,
    })));
    expect(html).toContain("发送 ⏎");
    expect(html, "输入框可用时不许还写着「推演中」").not.toContain("推演中");
    expect(html, "textarea 不被禁用").not.toMatch(/<textarea[^>]*disabled/);
  });
});

// ── ② 状态行:只在补得进去的那一轮上说 ──────────────────────────

describe("状态行 · 「现在发的话会补进这一轮」", () => {
  function line(props: Record<string, unknown>): string {
    return visible(renderToStaticMarkup(
      createElement(ChatComposer as (p: Record<string, unknown>) => ReactElement, {
        value: "", onChange: () => undefined, onSubmit: () => true, ...props,
      }),
    ));
  }

  it("正样本:对方正在回答、输入框可用 ⇒ 说清这句话会补进这一轮(并保留 Esc 中断)", () => {
    const text = line({ steerable: true, interruptible: true });
    expect(text).toContain("正在回答");
    expect(text).toContain("现在发的话会补进这一轮");
    expect(text).toContain("Esc 中断");
  });

  it("负样本:刷新之后(本地轮表空、服务端还在跑)补不补得进去不知道 ⇒ 不许说「会补进」", () => {
    const text = line({ steerable: false, interruptible: true });
    expect(text, "不知道走哪条路就别说会补进 —— 那是一句假话").not.toContain("会补进");
    expect(text).toContain("有回合在跑");
  });

  it("负样本:连接断着 / 输入框真被禁用时,状态行说那两件事,不说补话", () => {
    expect(line({ steerable: true, connection: "closed" })).not.toContain("会补进");
    expect(line({ steerable: true, disabled: true, reason: "noKey" })).not.toContain("会补进");
  });

  it("页面的判据与服务端同源:只有**甲方触发**且**就在这条线上**的轮才算补得进去", () => {
    const src = read("web/src/features/chat/ChatSurface.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toMatch(
      /activity\.client\.some\(\s*\(t\) =>\s*t\.origin\.source === "turn" && t\.origin\.trigger\.kind === "user" && t\.sessionId === sessionId,?\s*\)/,
    );
    expect(src).toContain("steerable={steerable}");
    // 占位文案与提示行都要有(不然用户不知道现在发的话走哪一条)。
    expect(src).toContain("现在发的话会补进这一轮…");
    expect(src).toContain("steeredNote !== null && steeredNote.sessionId === sessionId");
  });
});
