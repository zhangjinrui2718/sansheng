/**
 * Sansheng fs tools · M4
 *
 * 4 个基础文件操作,每个 function 强制第一个参数为 `Sandbox` 实例。
 * 所有 IO 走 sandbox.resolve / sandbox.statOrThrow → 错误统一 wrap 成 SandboxError。
 *
 * 设计纪律:
 *   - mtime 一律 number ms
 *   - size 一律 bytes number
 *   - 不抛 raw ENOENT/EACCES;统一 SandboxError(code, path)
 *   - 默认 utf8 read;content 走 string 返回(binary 走 base64)
 *   - 默认隐藏 .dotfile 不列;可由 {includeHidden:true} 覆盖
 */
import {
  readFile as nodeReadFile,
  writeFile as nodeWriteFile,
  readdir,
  lstat,
  stat as fsStat,
} from "node:fs/promises";
import { Sandbox, SandboxError } from "./sandbox.js";

export type Encoding = "utf8" | "base64";

export interface ReadOpts {
  encoding?: Encoding;
  /** 覆写 policy.maxBytes(单文件 size cap)。 */
  maxBytes?: number;
}

export interface WriteOpts {
  /** 若 parent 不存在则递归 mkdir(默认 false → not_found)。 */
  createDirs?: boolean;
}

export interface ListOpts {
  /** 最多返回条目数;默认不限。 */
  maxEntries?: number;
  /** 默认 true(隐式):过滤 .dotfiles。设为 false 包含 hidden。 */
  includeHidden?: boolean;
}

export interface ReadResult {
  content: string;
  mtimeMs: number;
}

export interface WriteResult {
  bytesWritten: number;
  mtimeMs: number;
}

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface ListEntry {
  name: string;
  kind: EntryKind;
  size?: number;
  mtimeMs?: number;
}

export interface StatResult {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
}

/** 读文件 → {content, mtimeMs}。content 为 utf8 string 或 base64 string。 */
export async function readFile(
  sandbox: Sandbox,
  path: string,
  opts: ReadOpts = {},
): Promise<ReadResult> {
  const real = await sandbox.resolve(path);
  let buf: Buffer;
  try {
    buf = await nodeReadFile(real);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new SandboxError(`file not found: ${path}`, "not_found", path);
    }
    if (e.code === "EACCES" || e.code === "EPERM") {
      throw new SandboxError(`permission denied: ${path}`, "outside_allowlist", path);
    }
    if (e.code === "EISDIR") {
      throw new SandboxError(`path is a directory, not file: ${path}`, "denied_kind", path);
    }
    throw err;
  }
  const bytes = buf.byteLength;
  const cap = opts.maxBytes ?? sandbox.policy.maxBytes ?? 30 * 1024;
  if (bytes > cap) {
    throw new SandboxError(
      `size ${bytes}B exceeds maxBytes ${cap}B`,
      "too_large",
      path,
    );
  }
  const encoding = opts.encoding ?? "utf8";
  const content = encoding === "base64" ? buf.toString("base64") : buf.toString("utf8");
  let mtimeMs: number;
  try {
    const s = await fsStat(real);
    mtimeMs = s.mtimeMs;
  } catch {
    mtimeMs = Date.now();
  }
  return { content, mtimeMs };
}

/**
 * 写文件 → {bytesWritten, mtimeMs}。
 * 默认拒写已存在目录(denied_kind);拒写父目录不存在(not_found)。
 */
export async function writeFile(
  sandbox: Sandbox,
  path: string,
  content: string | Uint8Array,
  opts: WriteOpts = {},
): Promise<WriteResult> {
  const buf =
    typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  const target = await sandbox.resolveForWrite(path, buf.byteLength, {
    createDirs: opts.createDirs ?? false,
  });
  // target 不存在 → 写新文件;target 已存在且是 dir/symlink → 拒绝
  try {
    const s = await lstat(target);
    if (s.isDirectory()) {
      throw new SandboxError(`target is a directory: ${path}`, "denied_kind", path);
    }
    if (s.isSymbolicLink()) {
      throw new SandboxError(
        `refusing to overwrite symlink: ${path}`,
        "symlink_escape",
        path,
      );
    }
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
    // 文件不存在,继续写
  }
  await nodeWriteFile(target, buf);
  const after = await fsStat(target);
  return { bytesWritten: buf.byteLength, mtimeMs: after.mtimeMs };
}

/** 列举目录条目。默认隐藏 .dotfile。 */
export async function listDir(
  sandbox: Sandbox,
  path: string,
  opts: ListOpts = {},
): Promise<ListEntry[]> {
  const real = await sandbox.resolve(path);
  let entries: string[];
  try {
    entries = await readdir(real);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new SandboxError(`dir not found: ${path}`, "not_found", path);
    }
    if (e.code === "ENOTDIR") {
      throw new SandboxError(`not a directory: ${path}`, "denied_kind", path);
    }
    if (e.code === "EACCES") {
      throw new SandboxError(`permission denied: ${path}`, "outside_allowlist", path);
    }
    throw err;
  }
  const includeHidden = opts.includeHidden ?? false;
  const cap = opts.maxEntries ?? Number.POSITIVE_INFINITY;
  const result: ListEntry[] = [];
  for (const name of entries) {
    if (!includeHidden && name.startsWith(".")) continue;
    const childPath = `${real}/${name}`;
    let kind: EntryKind = "other";
    let size: number | undefined;
    let mtimeMs: number | undefined;
    try {
      const lst = await lstat(childPath);
      if (lst.isDirectory()) kind = "dir";
      else if (lst.isSymbolicLink()) kind = "symlink";
      else if (lst.isFile()) kind = "file";
      size = Number(lst.size);
      mtimeMs = lst.mtimeMs;
    } catch {
      kind = "other";
    }
    result.push({ name, kind, size, mtimeMs });
    if (result.length >= cap) break;
  }
  return result;
}

/** stat 单个路径。不存在 → 'not_found';在 sandbox 外 → 'outside_allowlist'。 */
export async function stat(sandbox: Sandbox, path: string): Promise<StatResult> {
  const real = await sandbox.resolve(path);
  let st;
  try {
    st = await lstat(real);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new SandboxError(`path not found: ${path}`, "not_found", path);
    }
    throw err;
  }
  let kind: EntryKind;
  if (st.isDirectory()) kind = "dir";
  else if (st.isSymbolicLink()) kind = "symlink";
  else if (st.isFile()) kind = "file";
  else kind = "other";
  return { kind, size: Number(st.size), mtimeMs: st.mtimeMs };
}
