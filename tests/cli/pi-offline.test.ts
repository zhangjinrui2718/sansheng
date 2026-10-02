/**
 * 批次 4b · C11 —— daemon 强制 PI_OFFLINE="1" 覆盖用户显式值
 * (docs/CODE-REVIEW-2026-10-01.md §C11;位置漂移:commands.ts 现为 spawn env 行)
 *
 * 旧实现:`sansheng start -d` 的 spawn env 无条件写 `PI_OFFLINE: "1"`,
 * 覆盖用户显式 `PI_OFFLINE=0`;而前台 `sansheng start` 走 index.ts 的
 * `process.env.PI_OFFLINE = process.env.PI_OFFLINE ?? "1"` 尊重用户值 ——
 * 同一份配置两种行为,daemon 跑的是用户没要求的离线模式。
 *
 * 修复契约:缺省才补 "1";显式值(含 "0")原样传递,前台/daemon 行为一致。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDaemonEnv } from "../../src/cli/commands.js";

let saved: { data?: string; daemon?: string; offline?: string };

beforeEach(() => {
  saved = {
    data: process.env.SANSHENG_DATA,
    daemon: process.env.SANSHENG_DAEMON,
    offline: process.env.PI_OFFLINE,
  };
});

afterEach(() => {
  for (const [k, v] of [
    ["SANSHENG_DATA", saved.data],
    ["SANSHENG_DAEMON", saved.daemon],
    ["PI_OFFLINE", saved.offline],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("C11 · daemon env 尊重用户显式 PI_OFFLINE", () => {
  it("未设置 → 补默认值 1(离线默认不变)", () => {
    delete process.env.PI_OFFLINE;
    const env = buildDaemonEnv(process.env, "/tmp/data-c11");
    expect(env.PI_OFFLINE).toBe("1");
  });

  it("显式 PI_OFFLINE=0 → 原样保留(旧:被强制改写成 1)", () => {
    process.env.PI_OFFLINE = "0";
    const env = buildDaemonEnv(process.env, "/tmp/data-c11");
    // RED(修复前):=== "1"
    expect(env.PI_OFFLINE).toBe("0");
  });

  it("显式 PI_OFFLINE=1 → 原样保留", () => {
    process.env.PI_OFFLINE = "1";
    const env = buildDaemonEnv(process.env, "/tmp/data-c11");
    expect(env.PI_OFFLINE).toBe("1");
  });

  it("SANSHENG_DATA / SANSHENG_DAEMON 契约不变", () => {
    const env = buildDaemonEnv(process.env, "/tmp/data-c11");
    expect(env.SANSHENG_DATA).toBe("/tmp/data-c11");
    expect(env.SANSHENG_DAEMON).toBe("1");
  });

  it("不污染调用方的 env 对象(纯函数)", () => {
    delete process.env.PI_OFFLINE;
    const base = { ...process.env };
    buildDaemonEnv(base, "/tmp/data-c11");
    expect(base.PI_OFFLINE).toBeUndefined();
  });
});
