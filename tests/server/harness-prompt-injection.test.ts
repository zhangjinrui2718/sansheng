/**
 * 批次 5a.5 · T2 — harness communicator prompt 最后一跳接线(5a open question #1)
 *
 * 5a 已把 44 行新默认 prompt 落到 harness/system_prompts/communicator.md
 * (ensureHarness 三分支升级),但 kernel 直答 session(createPiSession →
 * createAgentSession 走 Pi DefaultResourceLoader)不消费 harness prompt →
 * 「落地了但没人读」。Communicator 类构造 opts 里的 systemPrompt 只服务
 * ensureSession(),而 ensureSession 无生产调用方。
 *
 * 注入点选型(论证见批次报告):createAgentSession({ resourceLoader }) ——
 * DefaultResourceLoader.appendSystemPromptOverride 把 harness prompt 追加在
 * SDK 默认 prompt 之后(system-prompt.js 渲染为 <addendum> 段,保留默认
 * preamble/tools/rules);harness prompt 为空 → 不传 resourceLoader,
 * 完全走 SDK 默认路径(不注入空段)。
 *
 * 断言方式:真实 createAgentSession(PI_OFFLINE=1 不触网,fake apiKey,
 * 与 ws-plan-integration 同形态)+ AgentSession.systemPrompt getter
 * (SDK 文档语义「Current effective system prompt」)—— 离线可行的最真实断言。
 *
 * 覆盖:
 *  ① start():有效 systemPrompt 含 harness 文本 + 保留 SDK 默认 preamble
 *  ② 用户编辑 md 后 resume() 重建 session → 新文本生效、旧文本消失(要求①②)
 *  ③ harness prompt 为空串 → 回退 SDK 默认,无 <addendum> 注入(要求③)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKernel } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage } from "../../src/server/storage/index.js";

const MARKER_A = "MARKER-T2-ALPHA-9x7 三生沟通员注入验证";
const MARKER_B = "MARKER-T2-BETA-3k1 用户手工编辑后的新 prompt";
/** SDK 默认 preamble(buildSystemPromptSections else 分支首句)——append 语义守护 */
const SDK_DEFAULT_PREAMBLE = "expert coding assistant";

let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

interface Ctx {
  dataDir: string;
  storage: Storage;
  kernel: AgentKernel;
}

const ctxs: Ctx[] = [];

function seedHarnessPrompt(dataDir: string, content: string): void {
  const dir = join(dataDir, "harness", "system_prompts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "communicator.md"), content, "utf-8");
}

async function makeKernel(tag: string): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), `sansheng-harness-inj-${tag}-`));
  // createPiSession 的 harness dataDir 派生:SANSHENG_DATA 优先(与生产 index.ts 一致)
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  const storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: `p-inj-${tag}`,
        label: `injection-test-${tag}`,
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-injection-test-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: `p-inj-${tag}`,
    cwd: dataDir,
    personaName: `三生-inj-${tag}`,
  });
  const kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  const ctx = { dataDir, storage, kernel };
  ctxs.push(ctx);
  return ctx;
}

beforeAll(() => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  process.env.PI_OFFLINE = "1";
});

afterAll(async () => {
  for (const c of ctxs) {
    try { c.kernel.invalidate(); } catch { /* ignore */ }
    try { c.storage.close(); } catch { /* ignore */ }
    rmSync(c.dataDir, { recursive: true, force: true });
  }
  if (savedPiOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedPiOffline;
  if (savedSanshengData === undefined) delete process.env.SANSHENG_DATA;
  else process.env.SANSHENG_DATA = savedSanshengData;
});

describe("kernel 直答 session 消费 harness communicator prompt(批次 5a.5 T2)", () => {
  it("①② start 注入 harness 文本(append 保留 SDK 默认)→ 编辑 md 后 resume 生效", async () => {
    const { dataDir, kernel } = await makeKernel("a");
    seedHarnessPrompt(dataDir, `# Communicator\n\n${MARKER_A}\n`);

    await kernel.start();
    const session = kernel.getSession();
    expect(session).toBeTruthy();
    // RED(旧代码):直答 session 走 Pi DefaultResourceLoader 默认路径,不读 harness
    expect(session!.systemPrompt).toContain(MARKER_A);
    // append 语义守护:harness 是追加段(<addendum>),SDK 默认 preamble 必须仍在
    // (若被 customPrompt 整体替换,此断言红 —— 直答 session 会失去 pi 内建工具指引)
    expect(session!.systemPrompt).toContain(SDK_DEFAULT_PREAMBLE);

    // 用户编辑 harness md → resume 重建 session(要求①:重建即生效;要求②:resume 路径)
    seedHarnessPrompt(dataDir, `# Communicator\n\n${MARKER_B}\n`);
    const convId = kernel.getConversationId();
    await kernel.resume(convId);
    const resumed = kernel.getSession();
    expect(resumed).toBeTruthy();
    expect(resumed!.systemPrompt).toContain(MARKER_B);
    expect(resumed!.systemPrompt).not.toContain(MARKER_A);
    expect(resumed!.systemPrompt).toContain(SDK_DEFAULT_PREAMBLE);
  }, 90_000);

  it("③ harness prompt 为空串 → 回退 SDK 默认,不注入空 addendum 段", async () => {
    const { dataDir, kernel } = await makeKernel("b");
    // 不 seed 任何 harness 文件 → loadHarness 得空串(loadHarness 语义)
    await kernel.start();
    const session = kernel.getSession();
    expect(session).toBeTruthy();
    expect(session!.systemPrompt).toContain(SDK_DEFAULT_PREAMBLE);
    // 无注入 → 无 <addendum> 段(空 addendum 会渲染出空标签噪音)
    expect(session!.systemPrompt).not.toContain("<addendum>");
    kernel.invalidate();

    // 显式空文件同样回退(空白串 trim 后为空 → 不注入)
    seedHarnessPrompt(dataDir, "   \n  ");
    await kernel.start();
    const session2 = kernel.getSession();
    expect(session2).toBeTruthy();
    expect(session2!.systemPrompt).toContain(SDK_DEFAULT_PREAMBLE);
    expect(session2!.systemPrompt).not.toContain("<addendum>");
  }, 90_000);
});
