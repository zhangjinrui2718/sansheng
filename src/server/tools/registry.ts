/**
 * Sansheng ToolRegistry · M4
 *
 * 轻量级工具注册表。M4 仅 fs 4 件套;后续 M4 后续(http/browser/notify)与 M5+ 工具陆续加入。
 *
 * 设计取舍:
 *   - 不强制 zod schema(M3b harness 也未引 zod);ToolFn 接 unknown,调用方负责类型/参数校验。
 *     后续若要做严格 schema,扩展为 `ToolFn<P, R>` generic 即可。
 *   - register 重复名 → throw(fail-fast,避免 silent overwrite)。
 *   - invoke 未知名 → throw TypeError(不是 SandboxError;registry 层错误与工具错误分离)。
 *   - invoke 包 try/catch,工具自身 throw 透传(caller 拿到原始错误,SandboxError 实例仍在)。
 */
export type ToolFn = (args: unknown) => Promise<unknown>;

export interface ToolRegistration {
  name: string;
  fn: ToolFn;
  description?: string;
}

export class ToolNotFoundError extends Error {
  public readonly toolName: string;
  constructor(name: string) {
    super(`tool not registered: ${name}`);
    this.name = "ToolNotFoundError";
    this.toolName = name;
    Object.setPrototypeOf(this, ToolNotFoundError.prototype);
  }
}

export class DuplicateToolError extends Error {
  public readonly toolName: string;
  constructor(name: string) {
    super(`tool already registered: ${name}`);
    this.name = "DuplicateToolError";
    this.toolName = name;
    Object.setPrototypeOf(this, DuplicateToolError.prototype);
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  /** 注册一个工具。重复名 → DuplicateToolError。 */
  register(name: string, fn: ToolFn, description?: string): void {
    if (this.tools.has(name)) {
      throw new DuplicateToolError(name);
    }
    const reg: ToolRegistration = description !== undefined
      ? { name, fn, description }
      : { name, fn };
    this.tools.set(name, reg);
  }

  /** 注销(测试 / 热替换用)。不存在不抛。 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 查找注册项。不存在 → undefined。 */
  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  /** 调用工具。未知名 → ToolNotFoundError;fn 抛错透传。 */
  async invoke(name: string, args: unknown): Promise<unknown> {
    const reg = this.tools.get(name);
    if (!reg) throw new ToolNotFoundError(name);
    return reg.fn(args);
  }

  /** 是否注册。 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 列出所有工具名(按注册顺序)。 */
  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 列出所有注册项的浅拷贝(按注册顺序)。 */
  entries(): ToolRegistration[] {
    return Array.from(this.tools.values());
  }

  /** 注册数量。 */
  size(): number {
    return this.tools.size;
  }
}
