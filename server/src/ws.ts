// WebSocket hub: presence + call signaling. The signaling payload carries the
// CALLER'S IDENTITY (resolved server-side from the account) so the callee always
// sees who is really calling — the core product principle (CLAUDE.md §2).
import type { WebSocketServer, WebSocket } from "ws";
import { getUser } from "./store.js";

type Client = { userId: string; socket: WebSocket };
const clients = new Map<string, Client>(); // userId -> connection

export function send(userId: string, type: string, payload: unknown) {
  const c = clients.get(userId);
  if (c && c.socket.readyState === 1) {
    c.socket.send(JSON.stringify({ type, payload }));
  }
}

export function broadcastPresence() {
  const online = [...clients.keys()];
  for (const c of clients.values()) {
    c.socket.send(JSON.stringify({ type: "presence", payload: { online } }));
  }
}

export function attachWs(wss: WebSocketServer) {
  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const userId = url.searchParams.get("userId");
    if (!userId || !getUser(userId)) {
      socket.close(4001, "unknown user");
      return;
    }

    clients.set(userId, { userId, socket });
    broadcastPresence();

    socket.on("message", (raw) => {
      let msg: { type: string; payload?: any };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { type, payload } = msg;

      // Relay signaling messages, always re-stamping caller identity from the
      // server's view of the connection — never trust the client's claim.
      if (type === "call:invite") {
        const caller = getUser(userId)!;
        send(payload.calleeId, "call:incoming", {
          callId: payload.callId,
          callType: payload.callType,
          // identity travels with the call:
          caller: { id: caller.id, name: caller.name, avatar: caller.avatar },
        });
      } else if (type === "call:accept") {
        send(payload.toUserId, "call:accepted", { callId: payload.callId });
      } else if (type === "call:dismiss") {
        send(payload.toUserId, "call:dismissed", {
          callId: payload.callId,
          reason: payload.reason ?? "busy",
        });
      } else if (type === "call:hangup") {
        send(payload.toUserId, "call:ended", { callId: payload.callId });
      } else if (
        // WebRTC media negotiation — relay SDP offer/answer + ICE candidates
        // verbatim between the two participants. The server never inspects media;
        // it only passes these through, stamping who they came from.
        type === "webrtc:offer" ||
        type === "webrtc:answer" ||
        type === "webrtc:ice"
      ) {
        send(payload.toUserId, type, { ...payload, fromUserId: userId });
      }
    });

    socket.on("close", () => {
      clients.delete(userId);
      broadcastPresence();
    });
  });
}
