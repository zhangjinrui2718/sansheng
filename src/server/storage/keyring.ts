import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { log } from "../../shared/log.js";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEYRING_VERSION = 1;

/**
 * 批次 4b B7(审查 §B7「Keyring/db 安全形态」)—— 威胁模型一句话版,
 * 完整版见 docs/SECURITY-NOTES.md:
 *  - **防**:同一台机器上的**其他用户**读到会话/记忆/密钥材料(权限位 0600);
 *  - **不防**:root、同一用户下的其它进程(能 ptrace / 读 /proc/<pid>/environ
 *    / 读你的家目录)、内存与 swap 里的明文 key、崩溃转储;
 *  - `.keyring` 里的 masterKey 是**明文 base64** —— 所谓「加密」只防「随手
 *    打开 settings.json 瞄一眼」,不防任何能读到那个文件的人。真正的边界是
 *    文件权限,不是密文。
 */
interface KeyringFile {
  version: number;
  masterKey: string; // base64
}

export class Keyring {
  private masterKey: Buffer;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as KeyringFile;
      if (raw.version !== KEYRING_VERSION) {
        throw new Error(`unsupported keyring version: ${raw.version}`);
      }
      this.masterKey = Buffer.from(raw.masterKey, "base64");
      if (this.masterKey.length !== KEY_BYTES) {
        throw new Error(`master key wrong size: ${this.masterKey.length}, expected ${KEY_BYTES}`);
      }
      // B7:读取路径也收紧权限。旧实现只在**新建**时 chmod,历史遗留的 0644
      // .keyring 会被原样沿用 —— 本机其他用户照样能读走 masterKey。
      tightenKeyringPermissions(filePath);
    } else {
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.masterKey = randomBytes(KEY_BYTES);
      const data: KeyringFile = { version: KEYRING_VERSION, masterKey: this.masterKey.toString("base64") };
      writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
      chmodSync(filePath, 0o600);
    }
  }

  encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;
    // 已加密的(由 isEncrypted 判断)就直接返回
    if (isEncrypted(plaintext)) return plaintext;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.masterKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
  }

  decrypt(blob: string): string {
    if (!blob) return blob;
    if (!isEncrypted(blob)) return blob; // 明文直通
    const parts = blob.split(":");
    if (parts.length !== 3) throw new Error("malformed encrypted blob");
    const [ivB64, tagB64, encB64] = parts;
    if (!ivB64 || !tagB64 || !encB64) throw new Error("malformed encrypted blob");
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const enc = Buffer.from(encB64, "base64");
    const decipher = createDecipheriv(ALGO, this.masterKey, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf-8");
  }

  /**
   * 轮换 masterKey。
   *
   * ⚠️ **危险且当前无生产调用方**(B7 审查如实记录:「一旦接线即数据销毁器」):
   * 换掉 masterKey 之后,settings.json 里所有**用旧 key 加密的 apiKey 立刻
   * 解不开**,store.ts 会逐个 catch 后静默置空 —— 等于清空用户的全部 provider
   * 凭据。正确接线形态是「先读出全部明文 → 换 key → 用新 key 重写整个
   * settings.json」,那需要 SettingsStore 参与,不属于本文件职责。
   * 因此这里只做**原子性**修复(旧实现 unlink → write 中间有个「文件已删、
   * 新文件未写」的窗口,此刻崩掉 = 永久丢失全部密钥),并把「重加密缺失」
   * 写进 docstring,防止下一个接线的人以为 rotate() 是安全的。
   *
   * 改成 tmp + rename:同目录 rename 在同一文件系统上是原子的,读者
   * (其它进程)要么看到完整旧文件,要么看到完整新文件,看不到半截/缺失。
   */
  rotate(): void {
    this.masterKey = randomBytes(KEY_BYTES);
    const data: KeyringFile = { version: KEYRING_VERSION, masterKey: this.masterKey.toString("base64") };
    const tmpPath = join(dirname(this.filePath), `.keyring.rotate.${process.pid}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    try {
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      // rename 失败时别把 tmp 留在磁盘上(它含明文 masterKey)
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
    tightenKeyringPermissions(this.filePath);
  }
}

/**
 * B7:把 .keyring 权限收紧到 0600(best-effort —— 权限收紧是纵深防御,
 * 失败不该把整个 server 打死)。新建路径已带 mode:0o600,这里覆盖的是
 * 历史遗留的 0644 形态。
 */
function tightenKeyringPermissions(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch (err) {
    log.warn(
      `keyring: chmod 0600 failed for ${filePath} (continuing — 见 docs/SECURITY-NOTES.md 威胁模型):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** 检测字符串是否像加密 blob(iv:tag:cipher 全 base64) */
export function isEncrypted(s: string): boolean {
  if (!s || typeof s !== "string") return false;
  const parts = s.split(":");
  if (parts.length !== 3) return false;
  return parts.every((p) => /^[A-Za-z0-9+/]+=*$/.test(p) && p.length >= 8);
}

/** 检测是否是 masked placeholder(如 "sk-***" 或 "****"),不能拿来加密 */
export function isMaskedApiKey(s: string): boolean {
  if (!s) return false;
  if (s.includes("***") || s.includes("****")) return true;
  if (s.length < 8) return true; // 太短不像真 key
  return false;
}