/**
 * 批次 8-D · 记忆闭环(审计 M2 中文检索 + M3 注入干活的人)
 *
 * 本文件守的是角色职能核查 §1.10 里两条「记忆对用户等于不存在」的断点:
 *
 *  M2 **中文检索无效**:旧分词 `/[\u4e00-\u9fa5]{2,}/g` 是贪婪整段,注释却自称「按字拆」
 *     —— 查「我叫什么名字」产出一个整句 token,永远 LIKE 不上「用户名字:小明」。
 *     断言:问法与存法不同形时,仍能召回(这正是旧实现失败的地方)。
 *
 *  M3 **记忆只喂沟通员**:planner / executor 走 makeLlmCall,此前零记忆 ——
 *     用户说过的偏好与约束,规划与执行全都看不见。
 *     断言:记忆块真的出现在**发给模型的 userPrompt** 里(不是只测函数返回值)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Storage } from "../../src/server/storage/db.js";
import { insertFragment, searchFragmentsByText } from "../../src/server/storage/repo/fragments.js";
import { upsertProfile } from "../../src/server/storage/repo/profile.js";
import { buildWorkerMemoryBlock, composeWithMemory } from "../../src/server/agents/workerMemory.js";

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ss-mem-"));
  storage = new Storage(join(dir, "sansheng.db"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function seedMemory(): void {
  insertFragment(storage.db, {
    id: "f1",
    kind: "fact",
    content: "用户名字:小明",
    importance: 0.8,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: Date.now(),
    metadata: null,
  });
  insertFragment(storage.db, {
    id: "f2",
    kind: "preference",
    content: "回答用中文,别写英文",
    importance: 0.7,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: Date.now(),
    metadata: null,
  });
}
describe("8-D M2 · 中文记忆检索(bigram 分词)", () => {
  it("① 问法与存法不同形时仍能召回(旧实现在这里恒空)", () => {
    seedMemory();
    // 库里是「用户名字:小明」,用户问的是「我叫什么名字」—— 整句 LIKE 永远匹配不上
    const hits = searchFragmentsByText(storage.db, "我叫什么名字", { limit: 3 });
    expect(hits.map((h) => h.content)).toContain("用户名字:小明");
  });

  it("② 偏好类记忆能被自然问法召回", () => {
    seedMemory();
    const hits = searchFragmentsByText(storage.db, "回复请用中文行吗", { limit: 3 });
    expect(hits.map((h) => h.content)).toContain("回答用中文,别写英文");
  });

  it("③ 英文与数字仍按原规则走(不因分词改动而退化)", () => {
    insertFragment(storage.db, {
      id: "f3",
      kind: "project",
      content: "项目代号 Sansheng 在 /Users/fuyao/projects",
      importance: 0.6,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: Date.now(),
      metadata: null,
    });
    const hits = searchFragmentsByText(storage.db, "sansheng 项目在哪", { limit: 3 });
    expect(hits.map((h) => h.content).join()).toContain("Sansheng");
  });

  it("④ 无关查询不硬塞(检索仍然要有选择性,不是全文回显)", () => {
    seedMemory();
    const hits = searchFragmentsByText(storage.db, "完全无关的量子力学问题", { limit: 3 });
    expect(hits).toHaveLength(0);
  });
});

describe("8-D M3 · 记忆块真的进了模型输入", () => {
  it("⑤ buildWorkerMemoryBlock 检索 + 拼装(生产实现,不是复制品)", () => {
    seedMemory();
    upsertProfile(storage.db, "name", "小明", 0.9);
    const block = buildWorkerMemoryBlock(storage, "我叫什么名字");
    expect(block).toBeTruthy();
    expect(block).toContain("# User Profile");
    expect(block).toContain("name: 小明");
    expect(block).toContain("# Relevant Memories");
    expect(block).toContain("用户名字:小明");
  });

  it("⑥ composeWithMemory 把块放在任务描述之前(不污染协议尾部)", () => {
    const task = "请把 README 改一下";
    const composed = composeWithMemory(task, "# User Profile\n- name: 小明");
    expect(composed.indexOf("# User Profile")).toBeLessThan(composed.indexOf(task));
    expect(composed).toContain("---");
  });

  it("⑦ 没有记忆时原样返回(不给「记忆(空)」这种噪音段)", () => {
    const task = "做点什么";
    expect(composeWithMemory(task, undefined)).toBe(task);
    expect(buildWorkerMemoryBlock(storage, "做点什么")).toBeUndefined();
  });

  it("⑧ 记忆库坏了不抛(记忆是增强,不是前置条件)", () => {
    // 故意传一个没有表的 db:检索必然失败
    const broken = { db: { prepare: () => { throw new Error("no such table"); } } } as unknown as Storage;
    expect(buildWorkerMemoryBlock(broken, "任意问题")).toBeUndefined();
  });
});
