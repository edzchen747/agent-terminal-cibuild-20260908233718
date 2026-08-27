import type { AddressInfo } from "node:net";
import type { DeviceIdentity, HostSnapshot, ServerMessage, ClientMessage } from "@agentterminal/protocol";
import { decodeClientMessage, encodeMessage } from "@agentterminal/protocol";
import { WebSocket, WebSocketServer } from "ws";

export interface ClientContext {
  deviceId?: string;
  attachedSessions: Set<string>;
  send: (message: ServerMessage) => void;
  close: () => void;
}

interface RemoteServerOptions {
  port: number;
  getSnapshot: () => HostSnapshot;
  pair: (token: string, device: DeviceIdentity) => string | null;
  authenticate: (deviceId: string, token: string) => boolean;
  onAuthenticated: (deviceId: string) => void;
  execute: (message: ClientMessage) => Promise<ServerMessage | null>;
}

export class RemoteServer {
  private readonly server: WebSocketServer;
  private readonly clients = new Set<ClientContext>();
  private readonly externalClients = new Map<string, ClientContext>();

  constructor(private readonly options: RemoteServerOptions) {
    this.server = new WebSocketServer({ host: "0.0.0.0", port: options.port, maxPayload: 1024 * 1024 });
    this.server.on("connection", (socket) => {
      const client: ClientContext = {
        attachedSessions: new Set(),
        send: (message) => this.sendSocket(socket, message),
        close: () => socket.close(4003, "Connection closed")
      };
      this.clients.add(client);
      socket.on("message", (data) => void this.handleMessage(client, data.toString()));
      socket.on("close", () => this.clients.delete(client));
      socket.on("error", () => this.clients.delete(client));
    });
  }

  addExternalClient(connectionId: string, send: (message: ServerMessage) => void, close: () => void): ClientContext {
    const existing = this.externalClients.get(connectionId);
    if (existing) return existing;
    const client: ClientContext = { attachedSessions: new Set(), send, close };
    this.externalClients.set(connectionId, client);
    this.clients.add(client);
    return client;
  }

  removeExternalClient(connectionId: string): void {
    const client = this.externalClients.get(connectionId);
    if (client) {
      this.clients.delete(client);
      this.externalClients.delete(connectionId);
    }
  }

  handleExternalMessage(client: ClientContext, raw: string): void {
    void this.handleMessage(client, raw);
  }

  get port(): number {
    const address = this.server.address() as AddressInfo | null;
    return address?.port ?? this.options.port;
  }

  broadcastSnapshot(): void {
    const message: ServerMessage = { type: "snapshot", snapshot: this.options.getSnapshot() };
    for (const client of this.clients) if (client.deviceId) client.send(message);
  }

  sendOutput(sessionId: string, data: string): void {
    for (const client of this.clients) if (client.deviceId && client.attachedSessions.has(sessionId)) client.send({ type: "session.output", sessionId, data });
  }

  disconnectDevice(deviceId: string): void {
    for (const client of this.clients) if (client.deviceId === deviceId) client.close();
  }

  close(): void {
    for (const client of this.clients) client.close();
    this.server.close();
  }

  private async handleMessage(client: ClientContext, raw: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = decodeClientMessage(raw);
    } catch {
      client.send({ type: "error", code: "BAD_MESSAGE", message: "The message could not be parsed." });
      return;
    }

    if (message.type === "pair") {
      const deviceToken = this.options.pair(message.token, message.device);
      if (!deviceToken) {
        client.send({ type: "error", requestId: message.requestId, code: "PAIRING_DENIED", message: "This pairing QR is no longer valid. Reopen the desktop pairing window and scan the new QR." });
        return;
      }
      client.deviceId = message.device.id;
      this.options.onAuthenticated(message.device.id);
      client.send({ type: "pair.accepted", requestId: message.requestId, deviceToken, snapshot: this.options.getSnapshot() });
      return;
    }

    if (message.type === "auth") {
      if (!this.options.authenticate(message.deviceId, message.deviceToken)) {
        client.send({ type: "error", requestId: message.requestId, code: "AUTH_DENIED", message: "This device is no longer authorized." });
        return;
      }
      client.deviceId = message.deviceId;
      this.options.onAuthenticated(message.deviceId);
      client.send({ type: "auth.accepted", requestId: message.requestId, snapshot: this.options.getSnapshot() });
      return;
    }

    if (!client.deviceId) {
      client.send({ type: "error", requestId: "requestId" in message ? message.requestId : undefined, code: "AUTH_REQUIRED", message: "Pair or authenticate before sending commands." });
      return;
    }

    if (message.type === "session.attach") client.attachedSessions.add(message.sessionId);
    if (message.type === "session.detach") client.attachedSessions.delete(message.sessionId);

    try {
      const response = await this.options.execute(message);
      if (response) client.send(response);
    } catch (error) {
      client.send({
        type: "error",
        requestId: "requestId" in message ? message.requestId : undefined,
        code: "COMMAND_FAILED",
        message: error instanceof Error ? error.message : "The desktop could not complete the command."
      });
    }
  }

  private sendSocket(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(encodeMessage(message));
  }
}
