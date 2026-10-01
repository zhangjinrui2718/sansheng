/**
 * Sansheng · App 级 WebSocket 单例(批次 3 F1 / A7-2)
 *
 * 缺陷(docs/CODE-REVIEW-2026-10-01.md §A7-2):socket 生命周期绑死在 chat 路由的
 * ChatSurface useEffect 上 —— 切到 Timeline/Agents/Memory 路由即 unmount → close:
 *   - Timeline 上 pending_question 的「回答/取消」按钮把命令发进 null socket,
 *     ChatSocket.send 静默 no-op(100% 失效);
 *   - 每次路由切换断流重连,server 端 sink 反复重建,流式输出中断。
 *
 * 修复:App mount 即 initAppSocket() 建模块级单例(与 App 同生命周期,路由切换
 * 不断连);React.StrictMode 双 effect / 重复调用幂等。事件统一进 chat store 的
 * applyEvent,store 的命令发送(sendLoadConversation/sendAnswerQuestion/…)经
 * attachSocket 走同一实例。组件需要直接发帧时用 getAppSocket()。
 *
 * 注:相对导入(vitest 无 `@` alias,tests/web/app-socket.test.ts 直接 import 本模块)。
 */
import { ChatSocket } from "./ws";
import { useChatStore } from "../stores/chat";

let appSocket: ChatSocket | null = null;

/**
 * 初始化(幂等)App 级 socket 单例并接线 store。
 * 返回单例本身,便于调用方直接使用。
 */
export function initAppSocket(): ChatSocket {
  if (appSocket) return appSocket;
  const sock = new ChatSocket("/ws");
  appSocket = sock;
  // server 事件 → store(单通道,组件不再各自 on())
  sock.on((e) => useChatStore.getState().applyEvent(e));
  // store 命令出口(load_conversation / answer_question / bus_replay / …)
  useChatStore.getState().attachSocket(sock);
  sock.connect();
  return sock;
}

/** 取当前单例;initAppSocket() 之前调用返回 null。 */
export function getAppSocket(): ChatSocket | null {
  return appSocket;
}
