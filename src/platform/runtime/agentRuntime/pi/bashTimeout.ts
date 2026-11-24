/**
 * 内置 `bash` 的默认超时与封顶(2026-11-25,看门狗第二道闸的软着陆)
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * SDK 的 `bash` 工具**没有默认超时**(`core/tools/bash.js`:
 * `timeout` 是可选参数,"optional, no default timeout"),模型不给就一条命令
 * 可以一直跑到回合被平台打断 —— 而平台能做的只有 `AgentSession.abort()`
 * (整回合停),SDK 没有「只停这一次工具调用」的入口。
 *
 * ⇒ 给 `bash` 包一层:模型没给 `timeout` 就补上单工具窗口,给了就**封顶**到同一个数。
 * 到点时 SDK 自己杀掉这条命令,并把「超时」作为**工具结果**交还模型 ——
 * 模型拿到结果可以换个做法继续(拆小、放后台),回合不用整个作废。
 * 只有自带超时的 `bash` 能这样软着陆;别的工具超时仍然只能整回合停
 * (`runtime/turn.ts` 的看门狗)。
 *
 * ── 怎么覆盖内置工具 ────────────────────────────────────────────
 *
 * SDK 里**同名的自定义工具覆盖内置**(`agent-session.js` 的 `_refreshToolRegistry`
 * 对 customTools 逐个 `definitionRegistry.set(name, …)`),而 `tools:` 只收名字。
 * 所以这里用 SDK 导出的 `createBashToolDefinition` 造出内置那一份,只换
 * `execute`(补 / 封顶 `timeout`)与 `description`(把上限告诉模型),
 * 经 `customTools` 交给会话。
 *
 * ⚠️ 外面套一层 SDK 自己的 `defineTool`:带具体参数类型的工具定义放进 `customTools`
 * 时,参数类型会被加宽成 `unknown`(SDK 注释原话),`defineTool` 就是为此准备的。
 *
 * ── 纪律 ────────────────────────────────────────────────────────
 *
 * 判据是两个**纯函数**(`resolveBashTimeout` / `bashTimeoutDescription`),
 * 包装函数不含任何逻辑 —— 与 `toolsAdapter.ts` 同一条纪律。
 */
import {
  createBashToolDefinition, defineTool,
  type BashToolInput, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** SDK 内置 bash 的那份工具定义(类型直接取返回值,不自己重抄一遍签名)。 */
export type BashToolDefinition = ReturnType<typeof createBashToolDefinition>;

/**
 * 这次调用实际生效的超时(秒)。
 *
 * - 模型没给(或缺省 / 非正 / 非有限)⇒ 单工具窗口(整秒,至少 1 秒);
 * - 模型给了 ⇒ **不超过**窗口(想更短可以,想更长不行 —— 更长的活放后台跑)。
 */
export function resolveBashTimeout(requested: number | undefined, windowMs: number): number {
  const windowSec = Math.max(1, Math.floor(windowMs / 1000));
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return windowSec;
  return Math.min(requested, windowSec);
}

/** 给模型看的工具说明:在内置说明后面补一句上限与到点的后果。 */
export function bashTimeoutDescription(base: string, limitSeconds: number): string {
  return (
    `${base} In this deployment a command times out after ${limitSeconds}s unless you pass ` +
    `a shorter \`timeout\`; a longer one is capped at the same limit. On timeout the command ` +
    `is killed and the timeout is returned as the result — split the work or run long jobs ` +
    `in the background and poll.`
  );
}

/**
 * 给内置 bash 套上默认超时与封顶。
 *
 * @param base     SDK 造出来的内置 bash 定义(`createBashToolDefinition(cwd)`)
 * @param windowMs 单工具窗口(毫秒)—— 与看门狗的第二道闸**同一个数**
 */
export function withBashTimeout(base: BashToolDefinition, windowMs: number): ToolDefinition {
  const limitSeconds = resolveBashTimeout(undefined, windowMs);
  return defineTool({
    ...base,
    description: bashTimeoutDescription(base.description, limitSeconds),
    execute: (toolCallId: string, params: BashToolInput, signal, onUpdate, ctx) =>
      base.execute(
        toolCallId,
        {
          command: params.command,
          timeout: resolveBashTimeout(params.timeout, windowMs),
        },
        signal,
        onUpdate,
        ctx,
      ),
  });
}
