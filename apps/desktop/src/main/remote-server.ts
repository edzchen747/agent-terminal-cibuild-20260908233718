import type { AddressInfo } from "node:net";
import type { DeviceIdentity, HostSnapshot, ServerMessage, ClientMessage } from "@agentterminal/protocol";
import { decodeClientMessage, encodeMessage } from "@agentterminal/protocol";
import { WebSocket, WebSocketServer } from "ws";

interface ClientContext {
  socket: WebSocket;
  deviceId?: string;
  attachedSessions: Set<string>;
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

  constructor(private readonly options: RemoteServerOptions) {
    this.server = new WebSocketServer({ host: "0.0.0.0", port: options.port, maxPayload: 1024 * 1024 });
    this.server.on("connection", (socket) => {
      const client: ClientContext = { socket, attachedSessions: new Set() };
      this.clients.add(client);
      socket.on("message", (data) => void this.onMessage(client, data.toString()));
      socket.on("close", () => this.clients.delete(client));
      socket.on("error", () => this.clients.delete(client));
    });
  }

  get port(): number {
    const address = this.server.address() as AddressInfo | null;
    return address?.port ?? this.options.port;
  }

  broadcastSnapshot(): void {
    const message: ServerMessage = { type: "snapshot", snapshot: this.options.getSnapshot() };
    for (const client of this.clients) {
      if (client.deviceId) this.send(client, message);
    }
  }

  sendOutput(sessionId: string, data: string): void {
    for (const client of this.clients) {
      if (client.deviceId && client.attachedSessions.has(sessionId)) {
        this.send(client, { type: "session.output", sessionId, data });
      }
    }
  }

  disconnectDevice(deviceId: string): void {
    for (const client of this.clients) {
      if (client.deviceId === deviceId) client.socket.close(4003, "Device authorization revoked");
    }
  }

  close(): void {
    for (const client of this.clients) client.socket.close(1001, "Desktop host shutting down");
    this.server.close();
  }

  private async onMessage(client: ClientContext, raw: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = decodeClientMessage(raw);
    } catch {
      this.send(client, { type: "error", code: "BAD_MESSAGE", message: "The message could not be parsed." });
      return;
    }

    if (message.type === "pair") {
      const deviceToken = this.options.pair(message.token, message.device);
      if (!deviceToken) {
        this.send(client, { type: "error", requestId: message.requestId, code: "PAIRING_DENIED", message: "Pairing code is invalid or expired." });
        return;
      }
      client.deviceId = message.device.id;
      this.options.onAuthenticated(message.device.id);
      this.send(client, { type: "pair.accepted", requestId: message.requestId, deviceToken, snapshot: this.options.getSnapshot() });
      return;
    }

    if (message.type === "auth") {
      if (!this.options.authenticate(message.deviceId, message.deviceToken)) {
        this.send(client, { type: "error", requestId: message.requestId, code: "AUTH_DENIED", message: "This device is no longer authorized." });
        return;
      }
      client.deviceId = message.deviceId;
      this.options.onAuthenticated(message.deviceId);
      this.send(client, { type: "auth.accepted", requestId: message.requestId, snapshot: this.options.getSnapshot() });
      return;
    }

    if (!client.deviceId) {
      this.send(client, { type: "error", requestId: "requestId" in message ? message.requestId : undefined, code: "AUTH_REQUIRED", message: "Pair or authenticate before sending commands." });
      return;
    }

    if (message.type === "session.attach") client.attachedSessions.add(message.sessionId);
    if (message.type === "session.detach") client.attachedSessions.delete(message.sessionId);

    try {
      const response = await this.options.execute(message);
      if (response) this.send(client, response);
    } catch (error) {
      this.send(client, {
        type: "error",
        requestId: "requestId" in message ? message.requestId : undefined,
        code: "COMMAND_FAILED",
        message: error instanceof Error ? error.message : "The desktop could not complete the command."
      });
    }
  }

  private send(client: ClientContext, message: ServerMessage): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(encodeMessage(message));
  }
}

