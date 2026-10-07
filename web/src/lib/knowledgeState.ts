/**
 * 知识语料的状态判据(纯函数 —— 记忆页「知识语料」段用它)
 *
 * ── 为什么这段判断要抽出来 ───────────────────────────────────────
 *
 * 用户在记忆页那一段要回答的问题只有一个:**「这个机制有没有在正常运行」**。
 * 而这句话在界面上很容易退化成一句装饰性的绿字 —— 那就等于没有判据。
 * 所以这里把它写成**可测的派生状态**:每个 level 都有明确的、能从概览数字上
 * 重新算出来的判据,并且顺序有意为之(读不到 > 索引坏了 > 空 > 落后 > 正常)。
 *
 * ⚠️ **`runtime: "unavailable"` 不是「空语料」** —— 这个项目在
 * 「读不到渲染成空闲」上栽过(ProjectLiveView),这里同理:
 * 读不到必须说读不到,并且给出下一步(重启一次会把迁移应用上)。
 */
import type { KnowledgeOverviewView } from "@shared/types/platform";

export type CorpusLevel = "unavailable" | "broken" | "empty" | "lagging" | "ok";

export interface CorpusStatus {
  level: CorpusLevel;
  /** 一句话状态(第一屏) */
  label: string;
  /** 为什么这么判 + 下一步(悬停/副行显示) */
  detail: string;
}

/** 待进语料的来源总数。 */
export function pendingTotal(v: KnowledgeOverviewView): number {
  return v.pending.artifacts + v.pending.messages;
}

/**
 * 派生状态。判据顺序 = 严重程度顺序,`detail` 里必须带**下一步**。
 */
export function corpusStatus(v: KnowledgeOverviewView): CorpusStatus {
  if (v.runtime !== "ok") {
    return {
      level: "unavailable",
      label: "读不到语料",
      detail:
        `${v.problem ?? "语料表读不到"} —— 这是**读不到**,不是「语料是空的」。` +
        "重启一次 `platform-serve` 会把迁移 028 应用上。",
    };
  }
  if (v.ftsRows !== v.chunks) {
    return {
      level: "broken",
      label: "索引与行不一致",
      detail:
        `语料行 ${v.chunks} 条,而 FTS 索引里 ${v.ftsRows} 条 —— 两者必须相等。` +
        "这属于索引损坏(不是「没数据」):重建一次索引(重启服务/下一个回合边界都会触发)即可收回一致。",
    };
  }
  if (v.chunks === 0) {
    return {
      level: "empty",
      label: "还没有语料",
      detail:
        "项目里还没有可索引的来源(工件正文 / 对话正文),或者宿主刚起来还没扫。" +
        "索引由平台在**回合边界**与**启动时**自动做,不需要人手动触发。",
    };
  }
  const pending = pendingTotal(v);
  if (pending > 0 || (v.lagMs ?? 0) > 0) {
    const lag = v.lagMs === null ? "未知" : fmtSpan(v.lagMs);
    return {
      level: "lagging",
      label: pending > 0 ? `${pending} 条来源还没进语料` : "语料落后于来源",
      detail:
        `上次索引 ${v.lastIndexedAt === null ? "未知" : fmtSpan(v.at - v.lastIndexedAt)}前` +
        `(落后 ${lag})。这不是故障:索引只在**回合边界**与**启动时**跑,` +
        "下一个回合结束或重启一次就会补上;持续不降才说明机制没在跑。",
    };
  }
  return {
    level: "ok",
    label: "语料与来源一致",
    detail:
      `上次索引 ${v.lastIndexedAt === null ? "未知" : fmtSpan(v.at - v.lastIndexedAt)}前,` +
      `行与 FTS 索引一致(${v.chunks} 条)。索引由平台在回合边界自动维护,agent 只读。`,
  };
}

/** 相对时长(判据是给人看的,不追求毫秒级精度)。 */
export function fmtSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "未知";
  const s = Math.floor(ms / 1000);
  if (s < 45) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 2) return "1 分钟";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 2) return "1 小时";
  if (h < 36) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/**
 * `Pill` / `StatStrip` 的 tone。
 *
 * ⚠️ 取值必须落在 `components/ui/primitives.tsx` 的 `Tone` 闭集里 —— 自造一个
 * ("rust" 这种)不会报错,只会渲染成一个没有配色的标签(看起来像"这块没做完")。
 * 语义:jade 正常 / amber 要注意(落后) / mute 还没开始 / cinnabar 坏了或读不到。
 */
export function corpusTone(level: CorpusLevel): "jade" | "amber" | "mute" | "cinnabar" {
  switch (level) {
    case "ok": return "jade";
    case "lagging": return "amber";
    case "empty": return "mute";
    case "broken":
    case "unavailable": return "cinnabar";
  }
}
