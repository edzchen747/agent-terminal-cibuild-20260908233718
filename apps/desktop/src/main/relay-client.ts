import type { RelayMessage, ServerMessage } from "@agentterminal/protocol";
import { encodeMessage } from "@agentterminal/protocol";
import { WebSocket } from "ws";
import type { ClientContext, RemoteServer } from "./remote-server";

export class RelayClient {
  private socket?: WebSocket;
  private readonly clients = new Set<string>();
  private reconnectTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly endpoint: string,
    private readonly hostId: string,
    private readonly hostToken: string,
    private readonly remote: RemoteServer
  ) {}

  connect(): void {
    this.stopping = false;
    this.open();
  }

  close(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    for (const connectionId of this.clients) this.remote.removeExternalClient(connectionId);
    this.clients.clear();
  }

  private open(): void {
    if (this.stopping) return;
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;
    socket.on("open", () => {
      this.send({ type: "relay.register", hostId: this.hostId, hostToken: this.hostToken });
    });
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", () => {
      for (const connectionId of this.clients) this.remote.removeExternalClient(connectionId);
      this.clients.clear();
      if (!this.stopping) this.reconnectTimer = setTimeout(() => this.open(), 5_000);
    });
    socket.on("error", () => undefined);
  }

  private receive(raw: string): void {
    let message: RelayMessage;
    try { message = JSON.parse(raw) as RelayMessage; } catch { return; }
    if (message.type === "relay.message") {
      const client = this.clientFor(message.connectionId);
      this.remote.handleExternalMessage(client, message.payload);
    } else if (message.type === "relay.disconnect") {
      this.remote.removeExternalClient(message.connectionId);
      this.clients.delete(message.connectionId);
    } else if (message.type === "relay.error") {
      console.error("Agent Terminal relay error: " + message.message);
    }
  }

  private clientFor(connectionId: string): ClientContext {
    this.clients.add(connectionId);
    return this.remote.addExternalClient(
      connectionId,
      (message: ServerMessage) => this.send({ type: "relay.message", connectionId, payload: encodeMessage(message) }),
      () => this.send({ type: "relay.disconnect", connectionId })
    );
  }

  private send(message: RelayMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
