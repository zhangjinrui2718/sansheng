/**
 * Sansheng · Timeline BusRow memo 纯函数(批次 3 F5 / B10-4)
 *
 * 缺陷(docs/CODE-REVIEW-2026-10-01.md §B10-4):Timeline.tsx 旧比较器
 *   `(prev, next) => prev.msg === next.msg` 完全丢弃了 `now` prop ——
 *   只要 msg 引用不变,比较恒真,重渲被永久跳过,相对时间标签(「刚刚」/
 *   「N 秒前」)冻结在首次渲染值。旧注释还把「memo 也会放行变更」当成兜底,
 *   这是对 memo 语义的误解:自定义比较器返回 true 时 React 一定跳过重渲。
 *
 * 修复:比较器同时看 msg 引用与 now 的 30s 桶 ——
 *   - msg 变了 → 重渲(内容更新);
 *   - now 跨桶 → 重渲(时间标签刷新,粒度 30s,与显示精度「N 分钟前」匹配);
 *   - now 桶内抖动 → 跳过(抑制无谓重渲,B7 的初衷保留)。
 *
 * 抽成独立模块的原因:纯函数可在 node 环境直接单测(tests/web/busRow.test.ts),
 * 不依赖 DOM/React 渲染。
 */
import type { BusMessage } from "@shared/types/agents";

/** 时间桶宽度:30s(fmtRel 的秒级显示窗口,足够「N 秒前」不显得冻结) */
export const BUS_ROW_NOW_BUCKET_MS = 30_000;

/** 把时间戳归到 30s 桶(0→0,29_999→0,30_000→30_000,…) */
export function nowBucket(ts: number): number {
  return Math.floor(ts / BUS_ROW_NOW_BUCKET_MS) * BUS_ROW_NOW_BUCKET_MS;
}

export interface BusRowProps {
  msg: BusMessage;
  now: number;
}

/**
 * React.memo 自定义比较器:相等(返回 true)= 跳过重渲。
 * msg 用引用比较(busStream 中的消息对象不可变);now 用 30s 桶比较
 * (桶内变化不触发重渲,跨桶才刷新相对时间标签)。
 */
export function busRowPropsEqual(prev: BusRowProps, next: BusRowProps): boolean {
  return prev.msg === next.msg && nowBucket(prev.now) === nowBucket(next.now);
}
