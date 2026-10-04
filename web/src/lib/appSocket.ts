/**
 * Sansheng · App 级 WebSocket 单例
 *
 * 存在的理由(沿袭旧实现,机制没变):socket 生命周期必须与 App 相同,不能绑在
 * 某个路由组件的 useEffect 上 —— 否则切到「待办 / 工件 / 工作项」页即断开,
 * 那些页上的回答按钮会把命令发进 null socket 并**静默 no-op**,流式输出也会中断。
 *
 * 变更点只有一个:连接的类从旧 `ChatSocket`(conversationId 为中心)换成
 * `PlatformSocket`(契约的 ClientCommand / ServerEvent,projectId 为中心)。
 * 事件仍单通道进 chat store 的 `applyEvent`,组件不各自 `on()`。
 */
import { PlatformSocket } from "./ws";
import { useChatStore } from "../stores/chat";

let appSocket: PlatformSocket | null = null;

/** 初始化(幂等)App 级 socket 单例并接线 store。返回单例本身。 */
export function initAppSocket(): PlatformSocket {
  if (appSocket) return appSocket;
  const sock = new PlatformSocket("/ws");
  appSocket = sock;
  sock.on((e) => useChatStore.getState().applyEvent(e));
  useChatStore.getState().attachSocket(sock);
  sock.connect();
  return sock;
}

/** 取当前单例;initAppSocket() 之前调用返回 null。 */
export function getAppSocket(): PlatformSocket | null {
  return appSocket;
}
