/**
 * Sansheng · 工件的共享读取与共享词表(批次 UI U4)
 *
 * 改这一层之前,**同一份工件数据被 4 个页面各抄了一遍读取函数**
 * (Agents / Artifacts / Goals / AgentPanel —— 同样的 fetch、同样的 limit=200、
 * 同样的三个 useState、同样的 error 解析),`KIND_LABEL` / `STATUS_LABEL` /
 * `STATUS_TONE` / `KIND_TONE` / `AUTHOR_LABEL` 五张表也被抄了四遍。
 * 后果不是报错,是**慢慢漂移**:Goals 页的 `open` 写「进行中」、Agents 页的 `open`
 * 写「待处理」,两个页面对同一个状态给出两种读法;`--cyan` 在三处写
 * `var(--cyan, #4cc9c0)` 而 token 里根本没有这个变量。
 *
 * 本文件把这 5 张表 + 读取函数收成一份。四页共用后:
 * 同一个状态在四个页面读法一致,`--cyan` 有了正式定义(tokens.css),
 * 「这个数从哪来」只有一个答案。
 *
 * **读取行为与旧实现逐字等价** —— 同端点、同 limit、同错误解析、同
 * 「无 conversationId 时清空且不报错」;唯一变化是四个页面不再各写一份。
 * 反造假纪律不变:`limit` 仍与 server 端 listArtifacts 的上限一致,
 * 页面上每一个计数都仍是对**本次真实数组** filter 后的 length。
 */
import { useCallback, useEffect, useState } from "react";
import type { ArtifactKind, ArtifactStatus } from "@shared/types/blackboard";
import { useChatStore } from "@/stores/chat";
import type { Tone } from "@/components/ui/primitives";

/** 与 src/server/http/blackboardRoutes.ts listArtifacts 的上限一致。 */
export const ARTIFACT_LIMIT = 200;

export interface Artifact {
  id: string;
  scope: "global" | "conversation";
  conversationId?: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  refs?: string[];
  author: string;
  status: ArtifactStatus;
  executors?: string[];
  dependsOn?: string[];
  parentIntent?: string;
  metadata?: { source?: string; errorReason?: unknown; relatedArtifacts?: unknown; [k: string]: unknown };
  createdAt: number;
  updatedAt: number;
}

/**
 * 工件读取。所有 blackboard 派生页面(Agents / 工件 / 目标 / Agent 侧栏)共用这一个 hook。
 * 依赖 store 的 `artifactRevision` —— WS 的 artifact_created / artifact_status_changed
 * / plan_done 会在那里打戳,于是页面是**事件驱动回查**而不是轮询。
 * 权威数据永远回查后端,不进 store(避免两份真相)。
 *
 * `pollMs` 只给右侧 Agent 侧栏用:它额外挂一个慢速兜底轮询,好在 WS 断流时仍能收敛
 * (侧栏的「角色状态」是那三秒里唯一的真相)。三个页面传 0(纯事件驱动)。
 */
export function useArtifacts(options?: { pollMs?: number }): {
  artifacts: Artifact[];
  loading: boolean;
  error: string | null;
} {
  const conversationId = useChatStore((s) => s.conversationId);
  const artifactRevision = useChatStore((s) => s.artifactRevision);
  const pollMs = options?.pollMs ?? 0;
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  /**
   * 初始 `true` 而不是 `false` —— 这是**说真话**的问题,不是风格问题。
   *
   * 改这一层之前这里是 `useState(false)`,于是页面首帧(hook 还没跑、fetch 还没
   * 发出去)拿到的是 `{loading:false, artifacts:[]}`,三个页面都按「空」渲染,
   * 于是**先闪一句「本会话还没有工件」,再闪「加载中…」,最后才是真实结果**。
   * 那句「还没有」是在**还没问过服务器**时替用户下的结论 —— 界面在说假话,
   * 而且是每次切到该页必现的确定性闪烁,不是偶发。
   *
   * 正确做法:「还没查过」不等于「查过了,是空」。`conversationId` 为空时调用方
   * 先走「先选会话」分支,所以这里无条件 `true` 是安全的,不会造成永久转圈。
   */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!conversationId) {
      setArtifacts([]);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/artifacts?conversationId=${encodeURIComponent(conversationId)}&limit=${ARTIFACT_LIMIT}`,
      );
      const data = (await res.json()) as {
        artifacts?: Artifact[];
        error?: string;
        message?: string;
      };
      if (!res.ok || data.error) {
        setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        setArtifacts([]);
      } else {
        setArtifacts(Array.isArray(data.artifacts) ? data.artifacts : []);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setArtifacts([]);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load, artifactRevision]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const id = setInterval(() => {
      void load();
    }, pollMs);
    return () => clearInterval(id);
  }, [load, pollMs]);

  return { artifacts, loading, error };
}

// ───────────────────────────── 共享词表 ─────────────────────────────

export const KIND_LABEL: Record<string, string> = {
  intent: "意图",
  hypothesis: "假设",
  note: "笔记",
  decision: "决策",
  todo: "待办",
  evidence: "证据",
  critique: "批驳",
  reflection: "反思",
  harness_proposal: "提案",
  implementation_preview: "预览",
};

export const KIND_TONE: Record<string, Tone> = {
  intent: "jade",
  hypothesis: "amber",
  note: "bone",
  decision: "bamboo",
  todo: "cyan",
  evidence: "bone",
  critique: "ochre",
  reflection: "bone",
  harness_proposal: "ochre",
  implementation_preview: "ochre",
};

export const STATUS_LABEL: Record<string, string> = {
  open: "待处理",
  in_progress: "进行中",
  waiting_for_decision: "等决策",
  resolved: "已解决",
  superseded: "被取代",
  failed: "失败",
};

export const STATUS_TONE: Record<string, Tone> = {
  open: "mute",
  in_progress: "jade",
  waiting_for_decision: "amber",
  resolved: "bamboo",
  superseded: "mute",
  failed: "cinnabar",
};

/**
 * 状态机的白话读法 —— 回答「现在轮到谁」。工件页的核心价值就这一行,
 * 所以它进共享词表(旧实现只在 Artifacts.tsx 有,Goals 页没有)。
 */
export const STATUS_TURN: Record<string, string> = {
  open: "待接手",
  in_progress: "在推进",
  waiting_for_decision: "等人拍板",
  resolved: "已闭环",
  superseded: "已作废",
  failed: "已失败",
};

/**
 * author → 中文读法。**是翻译表不是名册**:critic / memory / reflection 虽不在
 * 角色表里(暂不实现,见 Agents.tsx 文件头),历史数据里可能有这些 author,
 * 原样显示才是信息;未知值原样透出,不猜。
 */
export const AUTHOR_LABEL: Record<string, string> = {
  user: "用户",
  communicator: "沟通员",
  planner: "规划员",
  executor: "执行员",
  critic: "评审员",
  memory: "记忆员",
  reflection: "反思员",
  harness_manager: "Harness 管理员",
};

export const kindLabel = (k: string): string => KIND_LABEL[k] ?? k;
export const kindTone = (k: string): Tone => KIND_TONE[k] ?? "bone";
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;
export const statusTone = (s: string): Tone => STATUS_TONE[s] ?? "mute";

/**
 * 「为什么会空 + 下一步该做什么」—— 三页共用一份文案。
 *
 * 收在一处的原因:这三个页面读的是**同一个端点的同一批数据**,所以「为什么空」
 * 的答案也是同一个。此前各写各的,已经漂成三种说法
 * (Agents 说「发送 /plan 你的目标」/ Artifacts 说「发一次 /plan」/
 * Goals 说「发送 /plan 你的目标 触发规划后」),其中两种还把占位符写成了
 * 看起来要照抄的字面量 —— 照抄进去 `goal` 就真的是「你的目标」四个字。
 *
 * 句式是刻意的:**只有 `/plan` 是字面量**,后面跟的内容由句法说明它是用户自己
 * 填的。不写成「发送 /plan <你的目标>」是因为尖括号在正文里会被读成标签;
 * 写成「以 /plan 开头发一条,后面跟你的目标」就没有这个歧义。
 */
export const PLAN_HOWTO = "以 /plan 开头发一条,后面跟你的目标。";
export const authorLabel = (a: string): string => AUTHOR_LABEL[a] ?? a;

// ───────────────────────────── 展示工具 ─────────────────────────────

/** `toLocaleString()` 的短格式:带日期,秒级精度不需要。 */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 时长:`0 秒 / 3 分 12 秒 / 2 小时 5 分`。非有限数或负数一律「—」,不显示 NaN。 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/** 折成单行并截断 —— 用于卡片摘要行,避免长 body 撑破布局。 */
export function excerpt(text: string, n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** 终态:只有终态才显示「用时」—— open / in_progress 的差值会随时间失真。 */
export const TERMINAL_STATUSES: readonly string[] = ["resolved", "failed", "superseded"];

/** 「还活着」= 没失败、没被取代。 */
export const ALIVE_STATUSES: readonly string[] = [
  "open",
  "in_progress",
  "waiting_for_decision",
  "resolved",
];

/** type guard:artifact 的可选字段全是 unknown,取数组前必须先收窄。 */
export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(isString) : [];
}
