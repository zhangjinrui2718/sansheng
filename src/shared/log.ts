/**
 * Sansheng shared logger · 控制台带 ANSI 颜色 + 时间戳。
 * 后续 M5 加 daemon log 重定向时复用。
 */
const ts = () =>
  new Date().toISOString().slice(11, 19);

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  fg: {
    jade: "\x1b[38;2;94;139;126m",
    bone: "\x1b[38;2;232;228;217m",
    ochre: "\x1b[38;2;199;107;74m",
    cinnabar: "\x1b[38;2;229;72;77m",
    mute: "\x1b[38;2;126;119;107m",
  },
};

function write(level: string, color: string, args: unknown[]): void {
  const tag = `${c.dim}[${ts()}]${c.reset} ${color}${level.padEnd(5)}${c.reset}`;
  // eslint-disable-next-line no-console
  console.log(tag, ...args);
}

export const log = {
  ok: (...args: unknown[]) => write("ok", c.fg.jade, args),
  info: (...args: unknown[]) => write("info", c.fg.bone, args),
  warn: (...args: unknown[]) => write("warn", c.fg.ochre, args),
  error: (...args: unknown[]) => write("error", c.fg.cinnabar, args),
  muted: (...args: unknown[]) => write("muted", c.fg.mute, args),
};