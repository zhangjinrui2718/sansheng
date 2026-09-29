import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEYRING_VERSION = 1;

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

  rotate(): void {
    this.masterKey = randomBytes(KEY_BYTES);
    if (existsSync(this.filePath)) unlinkSync(this.filePath);
    const data: KeyringFile = { version: KEYRING_VERSION, masterKey: this.masterKey.toString("base64") };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(this.filePath, 0o600);
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