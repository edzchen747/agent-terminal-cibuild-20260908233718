import http from "node:http";
import type { RelayMessage } from "@agentterminal/protocol";
import { WebSocket, WebSocketServer } from "ws";

interface HostPeer {
  socket: WebSocket;
  clients: Map<string, WebSocket>;
}

interface ClientPeer {
  socket: WebSocket;
  hostId: string;
  connectionId: string;
}

const port = Number(process.env.PORT ?? 8787);
const relaySecret = process.env.RELAY_SHARED_SECRET?.trim();
const hosts = new Map<string, HostPeer>();
const clients = new Map<string, ClientPeer>();
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const httpServer = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, hosts: hosts.size, connections: clients.size }));
    return;
  }
  response.writeHead(404);
  response.end("Not found");
});

httpServer.on("upgrade", (request, socket, head) => {
  webSocketServer.handleUpgrade(request, socket, head, (client) => webSocketServer.emit("connection", client));
});

webSocketServer.on("connection", (socket: WebSocket) => {
  let role: "host" | "client" | undefined;
  let hostId: string | undefined;
  let connectionId: string | undefined;

  socket.on("message", (raw) => {
    let message: RelayMessage;
    try { message = JSON.parse(raw.toString()) as RelayMessage; } catch { socket.close(4000, "Invalid message"); return; }

    if (!role && message.type === "relay.register") {
      if (relaySecret && message.hostToken !== relaySecret) { socket.close(4002, "Relay registration denied"); return; }
      if (hosts.has(message.hostId)) { socket.close(4001, "Host already connected"); return; }
      role = "host"; hostId = message.hostId;
      hosts.set(hostId, { socket, clients: new Map() });
      send(socket, { type: "relay.registered", hostId });
      return;
    }

    if (!role && message.type === "relay.connect") {
      const host = hosts.get(message.hostId);
      if (!host) { send(socket, { type: "relay.error", message: "Desktop host is offline." }); return; }
      role = "client"; hostId = message.hostId; connectionId = message.connectionId;
      const peer: ClientPeer = { socket, hostId, connectionId };
      clients.set(connectionId, peer); host.clients.set(connectionId, socket);
      send(socket, { type: "relay.connected", connectionId });
      return;
    }

    if (role === "host" && hostId && message.type === "relay.message") {
      const client = hosts.get(hostId)?.clients.get(message.connectionId);
      if (client) send(client, message);
      return;
    }

    if (role === "host" && hostId && message.type === "relay.disconnect") {
      disconnectClient(hostId, message.connectionId);
      return;
    }

    if (role === "client" && hostId && connectionId && message.type === "relay.message") {
      const host = hosts.get(hostId);
      if (host) send(host.socket, message);
      return;
    }
  });

  socket.on("close", () => {
    if (role === "host" && hostId) {
      const host = hosts.get(hostId);
      if (host?.socket === socket) {
        hosts.delete(hostId);
        for (const id of host.clients.keys()) disconnectClient(hostId, id);
      }
    } else if (role === "client" && hostId && connectionId) {
      disconnectClient(hostId, connectionId);
    }
  });
});

function disconnectClient(hostId: string, connectionId: string): void {
  const host = hosts.get(hostId);
  const client = clients.get(connectionId);
  if (host) {
    host.clients.delete(connectionId);
    send(host.socket, { type: "relay.disconnect", connectionId });
  }
  if (client) {
    clients.delete(connectionId);
    send(client.socket, { type: "relay.disconnect", connectionId });
    client.socket.close(1000, "Connection closed");
  }
}

function send(socket: WebSocket, message: RelayMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

httpServer.listen(port, "0.0.0.0", () => {
  console.log("Agent Terminal relay listening on " + port);
});
