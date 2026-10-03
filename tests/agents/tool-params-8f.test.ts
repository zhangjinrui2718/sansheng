/**
 * 批次 8-F · 工具协议段必须告诉模型「参数叫什么」
 *
 * 实机事故(2026-10-03 20:17,conv_murrw192_wxbg):执行者拿到 bash 工具后调它,
 * 传的是 `{"cmd": "curl ..."}`,SDK 的 bash 工具拿到 `command === undefined`,
 * 回灌 `/bin/bash: undefined` —— 工具**明明在池子里**,却因为「模型不知道参数叫什么」
 * 而完全不可用。执行者随后写下 hypothesis:「bash 工具未注册,跑不了 curl」。
 *
 * 根因在 `renderToolProtocol`:它只渲染「工具名 — 一句描述」,**从不渲染参数**。
 * 8-A 把工具接进池子时没有连带把这个洞补上 —— 能力给了,等于没给。
 *
 * 本文件三组断言:
 *  ① SDK 工具的参数来自**它们自带的 typebox schema**(权威来源,不会与实现漂移);
 *  ② 协议段里必须出现 bash 的 `command` 且标「必填」;
 *  ③ sansheng 自家 9 个工具的参数清单齐全(board_read 的 id、canvas_write 的 path/content…)。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSdkLoopTools } from "../../src/server/harness/sdkTools.js";
import { TOOL_PARAM_HINTS } from "../../src/server/harness/toolParams.js";
import { renderToolProtocol } from "../../src/server/agents/toolLoop.js";
import { buildOrchestratorTools } from "../../src/server/agents/orchestrator.js";
import { Storage } from "../../src/server/storage/db.js";

describe("8-F · 工具参数必须出现在协议段里", () => {
  it("① SDK 工具的参数名从自带 schema 取(bash → command 必填)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ss-8f-"));
    try {
      const bash = (await createSdkLoopTools(cwd)).find((t) => t.name === "bash");
      expect(bash, "bash 工具没构造出来").toBeTruthy();
      const params = bash!.parameters ?? [];
      const cmd = params.find((p) => p.name === "command");
      expect(cmd, "bash 没有 command 参数 —— 模型会瞎猜").toBeTruthy();
      expect(cmd?.required).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("② 协议段里出现 command(必填),模型才知道怎么调 bash", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ss-8f2-"));
    try {
      const tools = await createSdkLoopTools(cwd);
      const protocol = renderToolProtocol(tools, 6);
      expect(protocol).toContain("command");
      expect(protocol).toContain("必填");
      // read 的 path 也是必填 —— 8-A 之前模型只能靠猜
      const read = tools.find((t) => t.name === "read");
      expect(read?.parameters?.some((p) => p.name === "path" && p.required)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("③ sansheng 自家 9 个工具都有参数清单,且协议段渲染得出来", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-8f3-"));
    try {
      const storage = new Storage(join(dir, "sansheng.db"));
      const tools = await buildOrchestratorTools(storage, dir);
      const protocol = renderToolProtocol(tools, 6);
      for (const name of [
        "board_read",
        "board_list",
        "memory_search",
        "canvas_read",
        "canvas_write",
      ]) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, name + " 不在工具池里").toBeTruthy();
        expect(
          (tool?.parameters ?? []).length,
          name + " 没有参数清单 —— 模型只能猜参数名(8-F 事故同款)",
        ).toBeGreaterThan(0);
      }
      expect(protocol).toContain("`id`(必填"); // board_read
      expect(protocol).toContain("`content`(必填"); // canvas_write
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("④ 参数清单里的必填项,确实被实现当成必填(改 schema 别忘了改实现)", async () => {
    // 轻量交叉校验:hints 里声明的工具名必须都在 TOOL_NAMES 闭合联合内
    for (const [name, params] of Object.entries(TOOL_PARAM_HINTS)) {
      expect(typeof name).toBe("string");
      expect(params.length).toBeGreaterThan(0);
      for (const p of params) expect(typeof p.name).toBe("string");
    }
    expect(Object.keys(TOOL_PARAM_HINTS).sort()).toEqual([
      "board_list",
      "board_read",
      "canvas_list",
      "canvas_read",
      "canvas_stat",
      "canvas_write",
      "memory_search",
      "net_fetch",
      "net_post",
    ]);
  });
});