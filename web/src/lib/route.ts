/**
 * 路由 —— **UI 状态住在地址里**
 *
 * ── 它治的是什么病 ────────────────────────────────────────────────
 *
 * 2026-10-26 的盘点:`App.tsx:64` 的路由是 `useState<Route>("chat")`,
 * `Members.tsx:915` 选中的成员是 `useState<string | null>(null)`,
 * `Works.tsx:1767` 选中的工作项也是页面私有的 useState —— 而 `react-router-dom`
 * 明明装了,零引用。
 *
 * 三件事因此做不到,而它们正是用户说的「系统性关联」:
 *   - **不可分享**:把「这个成员的对话」发给别人,对方打开只能到首页;
 *   - **刷新即失忆**:F5 之后回到第一个成员 / 第一条工作项,用户得重新找;
 *   - **不能互相指**:工作项里提到一个 agent、交付物里提到一条工作项,都没法变成链接。
 *
 * ⇒ 所以每个「可以被指的东西」得先**有地址**。这一层就是地址语法本身。
 *
 * ── 语法 ──────────────────────────────────────────────────────────
 *
 *   `#/works?work=w_123`     工作项页,选中了某条工作项
 *   `#/members?member=a_9`   成员页,选中了某个成员
 *   `#/project`              项目页(默认)
 *   `#/chat`                 对话页(**不带参数** —— 当前项目由 store 决定)
 *
 * ⚠️ **`chat` 故意不带 `project=`**:「当前项目」是一个跨页面的选择(对话 / 项目 /
 * 工作项 / 成员 / 记忆都看它),把它钉在某一条路由的查询串里,会让「切到工作项页
 * 换了个项目」这件事丢失。它是 store 的 `activeProjectId`,不是路由参数。
 *
 * ⚠️ **未知路由 ⇒ `chat`**,不是白屏。地址栏是外来的(用户手打、旧收藏、别人发的),
 * 而白屏在屏幕上与「应用坏了」一模一样;`chat` 至少是可用的,且不会谎称到达了某个页面。
 */
import { useCallback, useEffect, useState } from "react";

export type Route =
  | "chat"
  | "project"
  | "works"
  | "members"
  | "memory"
  | "settings"
  /* 「关于」不是第七个页签(导航恒 6 项,见 `TopBar` 的 `TABS`)—— 它由顶栏末尾
     那个 `?` 打开:一块说明书不该和六个工作区抢位置。 */
  | "about";

/** 闭合集合 —— 解析与序列化共用,写错一个值 tsc 会报。 */
export const ROUTES: readonly Route[] = [
  "chat",
  "project",
  "works",
  "members",
  "memory",
  "settings",
  "about",
];

export interface AppLocation {
  route: Route;
  /** 查询串里的键值(已 decode)。**只有该页面认得的键**会被解读,其余原样保留。 */
  params: Readonly<Record<string, string>>;
}

export const HOME: AppLocation = { route: "chat", params: {} };

const isRoute = (s: string): s is Route => (ROUTES as readonly string[]).includes(s);

/** `decodeURIComponent` 会把 `%` 当成转义前缀 —— 手打一个裸 `%` 会让它抛错。 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 解析 `window.location.hash`(也接受不带 `#` 的、或者整条 URL 的尾巴)。
 * 未知路由 ⇒ `chat` 且**丢弃参数**(参数属于那条不存在的路由,留着只会误导)。
 */
export function parseHash(hash: string): AppLocation {
  let s = (hash ?? "").trim();
  const at = s.indexOf("#");
  if (at >= 0) s = s.slice(at + 1);
  if (s.startsWith("/")) s = s.slice(1);
  const q = s.indexOf("?");
  const rawRoute = q >= 0 ? s.slice(0, q) : s;
  const rawQuery = q >= 0 ? s.slice(q + 1) : "";
  const route = rawRoute === "" ? "chat" : safeDecode(rawRoute);
  if (!isRoute(route)) return HOME;

  const params: Record<string, string> = {};
  for (const part of rawQuery.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const key = safeDecode(eq >= 0 ? part.slice(0, eq) : part);
    const value = safeDecode(eq >= 0 ? part.slice(eq + 1) : "");
    if (key === "") continue;
    params[key] = value;
  }
  return { route, params };
}

/**
 * 序列化成 `location.hash` 的形态(`#/` 前缀)。
 * 键按字典序排 —— 同一份状态只该有**一个**地址字符串(否则「地址相等」这件事不可判)。
 */
export function toHash(loc: AppLocation): string {
  const query = Object.entries(loc.params)
    .filter(([, v]) => v !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return query === "" ? `#/${loc.route}` : `#/${loc.route}?${query}`;
}

/** 读一个参数(`null` = 没有,与「空串」分开 —— 空串是**写了但没值**)。 */
export function paramOf(loc: AppLocation, key: string): string | null {
  const v = loc.params[key];
  return v === undefined ? null : v;
}

/** 改一个参数(`null` = 删掉它)。返回新对象,不改入参。 */
export function withParam(loc: AppLocation, key: string, value: string | null): AppLocation {
  const params: Record<string, string> = { ...loc.params };
  if (value === null) delete params[key];
  else params[key] = value;
  return { route: loc.route, params };
}

/** 换路由。**默认清空参数** —— 上一个页面的 `work=…` 在成员页上是噪音。 */
export function toRoute(route: Route, params: Record<string, string> = {}): AppLocation {
  return { route, params };
}

const currentHash = (): string =>
  typeof window === "undefined" ? "#/chat" : window.location.hash;

/**
 * 路由 hook。**URL 是唯一真相**:组件不持有自己的副本,只读 `location.hash`。
 *
 * ⚠️ 不用 `react-router-dom`:它在仓库里**零引用**(装了没用),而这一层需要的
 * 只是「hash ↔ 结构」这一件事;引一个路由框架意味着引入它的一整套约定与测试面。
 * 等真需要嵌套路由 / loader 时再换,那时候换的是这个文件,不是 6 个页面。
 */
export function useAppLocation(): {
  loc: AppLocation;
  navigate: (loc: AppLocation) => void;
  setParam: (key: string, value: string | null) => void;
} {
  const [loc, setLoc] = useState<AppLocation>(() => parseHash(currentHash()));

  useEffect(() => {
    const sync = (): void => setLoc(parseHash(currentHash()));
    // 首帧之后补一次:**别的组件**可能已经改过 hash(此时本实例还没挂监听)。
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = useCallback((next: AppLocation) => {
    const hash = toHash(next);
    setLoc(next);
    if (typeof window !== "undefined" && window.location.hash !== hash) {
      window.location.hash = hash;
    }
  }, []);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setLoc((prev) => {
        const next = withParam(prev, key, value);
        const hash = toHash(next);
        if (typeof window !== "undefined" && window.location.hash !== hash) {
          window.location.hash = hash;
        }
        return next;
      });
    },
    [],
  );

  return { loc, navigate, setParam };
}
