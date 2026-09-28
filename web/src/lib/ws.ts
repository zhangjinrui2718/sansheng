/**
 * Sansheng WebSocket client · 单连接、双向 JSON 协议
 */
import type { ServerEvent, ClientCommand } from "@shared/types/ws";

type Handler = (e: ServerEvent) => void;

export class ChatSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private url: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;

  constructor(url = "/ws") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${proto}//${window.location.host}${url}`;
  }

  connect(): void {
    this.explicitlyClosed = false;
    this.openSocket();
  }

  private openSocket(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempts = 0;
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as ServerEvent;
        this.handlers.forEach((h) => h(data));
      } catch {}
    };
    ws.onclose = () => {
      if (this.explicitlyClosed) return;
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 8000);
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    };
    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  send(cmd: ClientCommand): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
    }
  }

  sendText(content: string): void {
    this.send({ type: "send", content });
  }

  interrupt(): void {
    this.send({ type: "interrupt" });
  }

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  close(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch {}
  }
}