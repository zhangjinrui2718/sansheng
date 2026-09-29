/**
 * Sansheng Bus Persister · M3c
 *
 * 把每条 BusMessage 落到 `~/.sansheng/sessions/<conversationId>/bus.jsonl`。
 * - appendBusMessage:fs.appendFile 一行 JSON(单写,接受偶尔丢最后一条)
 * - loadBusMessages :read + 按行 parse;损坏行打 warn 后跳过,不抛
 *
 * 设计取舍:不直接持久化 pending question — BusBus.restore 只填 stream,
 * pending 由 caller 重新发起(resume 路径在 kernel 层显式重放 unfinished ask)。
 */
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BusMessage } from "@shared/types/agents";
import { log } from "../../shared/log.js";

function sessionDir(dataDir: string, conversationId: string): string {
  return join(dataDir, "sessions", conversationId);
}

function busFile(dataDir: string, conversationId: string): string {
  return join(sessionDir(dataDir, conversationId), "bus.jsonl");
}

/**
 * 追加一条 BusMessage 到 jsonl。
 * 失败仅 log warn(总线流不应阻塞主流程)。
 */
export async function appendBusMessage(
  dataDir: string,
  conversationId: string,
  message: BusMessage,
): Promise<void> {
  try {
    const dir = sessionDir(dataDir, conversationId);
    await mkdir(dir, { recursive: true });
    const file = busFile(dataDir, conversationId);
    // 不持久化 resumeState(可恢复性低,体积大)
    const persisted: BusMessage = { ...message };
    delete persisted.resumeState;
    await appendFile(file, JSON.stringify(persisted) + "\n", "utf-8");
  } catch (err) {
    log.warn("appendBusMessage failed:", err);
  }
}

/**
 * 读取全部 BusMessage;损坏行跳过。
 */
export async function loadBusMessages(
  dataDir: string,
  conversationId: string,
): Promise<BusMessage[]> {
  const file = busFile(dataDir, conversationId);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return []; // 文件不存在视为空
  }
  const out: BusMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as BusMessage);
    } catch (err) {
      log.warn(`loadBusMessages: skip corrupt line: ${err}`);
    }
  }
  return out;
}

/**
 * 清空 bus.jsonl(测试或对话 reset 时调用)。
 */
export async function clearBusLog(dataDir: string, conversationId: string): Promise<void> {
  const file = busFile(dataDir, conversationId);
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(file);
  } catch {
    /* 文件不存在 ok */
  }
}