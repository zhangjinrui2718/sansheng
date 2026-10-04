/**
 * 甲方接口 · 端口
 *
 * ── 为什么是端口 ────────────────────────────────────────────────
 *
 * 「对甲方说话」的物理形态是传输层的活(WebSocket 推送到前端、等待用户输入)。
 * 但工具层不该知道 WebSocket 的存在 —— 否则工具又只能在真服务里测。
 *
 * 所以与 `MemoryPort` 同一个模式:工具依赖一个**窄接口**,传输层实现它,
 * 测试注入一个假的。`ask_client` 的行为(建工件、进 blocked、留痕)因此可以
 * 在没有任何网络的情况下被完整验证。
 *
 * ── 为什么提问必须落成工件 ────────────────────────────────────────
 *
 * 设计 1 §6.2:凡「工具本身的语义就是一条通信」的场景,记录必须与动作**原子地**
 * 落库。7-L 纪律的原话是「否则审计面上会出现『执行者拿到了一份没有 decision
 * 工件的指令』,那种问题事后查不出来」。
 *
 * 对甲方的提问尤其如此:用户答了什么、什么时候答的、当时的选项是什么,
 * 是事后唯一能重建「当初为什么这么决定」的材料。一次性的 Promise 兑现留不下它。
 */

export interface ClientQuestion {
  /** 问题正文 */
  question: string;
  /** 候选项(带各自代价)。给选项比开放式提问更容易得到可执行的答复。 */
  options?: readonly string[];
  /** 提问者的倾向 —— 让用户一眼看到「你建议怎么做」,而不是从零判断 */
  lean?: string;
}

/**
 * 传输层实现这个接口。`ask` 之后的环节(推送、等待)全在实现里。
 *
 * ── `projectId` 为什么是必填 ────────────────────────────────────
 *
 * 第一版没有它,于是 `tell()` 无处安放播报 —— 消息必须落进某个项目的会话,
 * 否则用户切项目时就看不见它。
 *
 * 而「按项目分组呈现」是经校准的裁决(2026-10-04,p=0.82):项目即上下文容器。
 * 所以传输层的每一条出站内容都必须带着它属于哪个项目。
 */
export interface ClientChannel {
  /**
   * 向甲方提问。**不阻塞工具调用** —— 它只负责把问题投出去,
   * 「提问者进入 blocked」这个状态由 `client_question` 工件的 open 状态表达,
   * 不靠挂起一个 Promise(旧 MessageBus 的阻塞模型就是这么失效的)。
   */
  ask(input: ClientQuestion & { questionId: string; projectId: string }): Promise<void>;

  /** 向甲方播报。不等待、不产生待答状态。 */
  tell(input: { projectId: string; message: string }): Promise<void>;
}

/**
 * 没有传输层时的实现:把问题记进日志,不假装送达。
 *
 * 用它而不是「抛错」,是因为在 CLI/测试场景里「记下来」是合理行为;
 * 但它**必须留下痕迹**,否则就成了「声称问了甲方、实际没人收到」。
 */
export function createLoggingClientChannel(
  log: (line: string) => void,
): ClientChannel {
  return {
    async ask({ questionId, projectId, question, options, lean }) {
      log(
        `[client.ask ${questionId} @${projectId}] ${question}` +
          (options !== undefined && options.length > 0 ? `\n  候选:${options.join(" | ")}` : "") +
          (lean !== undefined ? `\n  倾向:${lean}` : ""),
      );
    },
    async tell({ projectId, message }) {
      log(`[client.tell @${projectId}] ${message}`);
    },
  };
}
