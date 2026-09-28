/**
 * Token → 美元估算
 */
import type { Model } from "@earendil-works/pi-ai";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function estimateCost(model: Model<any> | undefined, usage: TokenUsage): number {
  if (!model) return 0;
  const c = (model as any).cost;
  if (!c) return 0;
  const input = (usage.input / 1_000_000) * (c.input ?? 0);
  const output = (usage.output / 1_000_000) * (c.output ?? 0);
  const cr = ((usage.cacheRead ?? 0) / 1_000_000) * (c.cacheRead ?? c.input ?? 0);
  const cw = ((usage.cacheWrite ?? 0) / 1_000_000) * (c.cacheWrite ?? c.input ?? 0);
  return Number((input + output + cr + cw).toFixed(6));
}