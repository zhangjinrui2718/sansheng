/**
 * 桌面通知 —— 「你不在屏幕前时发生的事」的最后一米
 *
 * ── 为什么是它 ──────────────────────────────────────────────────
 *
 * 三生是单人本地服务:界面上的一切(徽标 / 顶灯 / 横幅)都要**你在看**才存在。
 * 而「角色提问超时」「provider 限流自动暂停」这类事件恰恰发生在你不在看的时候 ——
 * 界面等你看才亮,通知不需要。`node-notifier` 这个依赖在 package.json 里
 * 躺了很久(2026-11-13 审计发现:声明零读者),这一批把它接上。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────
 *
 * 1. **fire-and-forget** —— 通知失败(终端环境没有通知后端 / osascript 出错)
 *    只落日志,**绝不**打挂调用方。通知是锦上添花,不是链路的一环。
 * 2. **同 key 去重** —— 调用方各带一个稳定 key(如 `provider-brake`);
 *    同一个 key 在窗口期内(缺省 10 分钟)只弹一次。理由:刹车的播报点是
 *    **每个项目各自第一次撞上刹车**,而刹车是进程级的 —— 没有这层去重,
 *    三个项目同时刹车会弹三张一模一样的卡片。
 * 3. **不判断「该不该弹」** —— 什么时候值得弹是调用方的判据(调度器只在集合
 *    变化时叫它;刹车的播报点自己有「同一条只播一次」),这里只管「怎么弹」。
 */
import notifier from "node-notifier";

export interface NotifierOptions {
  readonly now?: () => number;
  /** 同 key 去重窗口(毫秒),缺省 10 分钟 */
  readonly windowMs?: number;
}

export type DesktopNotifier = (
  key: string,
  title: string,
  message: string,
  /** 失败日志(缺省静默)—— 每次调用自带的,因为调用方各有一套日志 */
  log?: (line: string) => void,
) => void;

export function createNotifier(opts: NotifierOptions = {}): DesktopNotifier {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const lastAt = new Map<string, number>();
  return (key, title, message, log) => {
    const t = now();
    const prev = lastAt.get(key);
    if (prev !== undefined && t - prev < windowMs) return;
    lastAt.set(key, t);
    try {
      notifier.notify(
        { title, message, sound: false, wait: false },
        (err) => {
          if (err) log?.(`notify: 桌面通知失败(${String(err)})—— 不重试,不阻塞`);
        },
      );
    } catch (err) {
      log?.(`notify: 桌面通知不可用(${String(err)})—— 忽略`);
    }
  };
}

/** 宿主用的缺省实例(10 分钟去重窗口;去重表在实例上,所以只建一次)。 */
export const notifyDesktop = createNotifier();
