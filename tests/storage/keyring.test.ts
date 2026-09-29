import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keyring, isEncrypted, isMaskedApiKey } from "../../src/server/storage/keyring.js";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";

describe("Keyring", () => {
  let dir: string;
  let path: string;
  let k: Keyring;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sansheng-keyring-"));
    path = join(dir, ".keyring");
    k = new Keyring(path);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates file with chmod 0600", () => {
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("encrypt → decrypt roundtrip", () => {
    const plain = "sk-test-1234567890abcdef";
    const blob = k.encrypt(plain);
    expect(blob).not.toBe(plain);
    expect(isEncrypted(blob)).toBe(true);
    const back = k.decrypt(blob);
    expect(back).toBe(plain);
  });

  it("decrypt of plaintext returns plaintext", () => {
    const plain = "sk-something";
    expect(k.decrypt(plain)).toBe(plain);
  });

  it("encrypt of empty returns empty", () => {
    expect(k.encrypt("")).toBe("");
  });

  it("re-uses existing keyring", () => {
    const blob = k.encrypt("hello");
    const k2 = new Keyring(path);
    expect(k2.decrypt(blob)).toBe("hello");
  });

  it("isEncrypted 判断", () => {
    expect(isEncrypted("abc:def:ghi")).toBe(false); // 长度不够
    expect(isEncrypted("YWJjZGVmZ2hpamtsbW5vcA==:dGVzdHRlc3R0ZXN0dGVzdA==:ZW5jcnlwdGVkZGF0YQ==")).toBe(true);
    expect(isEncrypted("plain")).toBe(false);
  });

  it("isMaskedApiKey 判断", () => {
    expect(isMaskedApiKey("sk-***")).toBe(true);
    expect(isMaskedApiKey("****")).toBe(true);
    expect(isMaskedApiKey("ab")).toBe(true); // 太短
    expect(isMaskedApiKey("sk-real-key-1234567890")).toBe(false);
  });
});