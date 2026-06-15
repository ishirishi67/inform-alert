// WebSocket hub: presence + call signaling. The signaling payload carries the
// CALLER'S IDENTITY (resolved server-side from the account) so the callee always
// sees who is really calling — the core product principle (CLAUDE.md §2).
import type { WebSocketServer, WebSocket } from "ws";
import { calls, getUser } from "./store.js";
import { sendPush } from "./push.js";

type Client = { userId: string; socket: WebSocket };
const clients = new Map<string, Client>(); // userId -> connection

// Keep the Call record's status in step with the live signaling so a handled
// call isn't replayed as "ringing" when the callee reconnects.
function markCall(callId: string, status: (typeof calls)[number]["status"]) {
  const call = calls.find((c) => c.id === callId);
  if (call) {
    call.status = status;
    if (["dismissed_busy", "ended", "missed"].includes(status))
      call.endedAt = call.endedAt ?? Date.now();
  }
}

// Pending "they dropped" cleanups, so a brief reconnect doesn't end a live call.
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

function endActiveCalls(userId: string) {
  const now = Date.now();
  for (const c of calls) {
    if (
      (c.callerId === userId || c.calleeId === userId) &&
      (c.status === "ringing" || c.status === "accepted")
    ) {
      c.status = "ended";
      c.endedAt = now;
      const other = c.callerId === userId ? c.calleeId : c.callerId;
      send(other, "call:ended", { callId: c.id });
    }
  }
}

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

    // Back online — cancel any pending disconnect cleanup for this user.
    const pending = disconnectTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      disconnectTimers.delete(userId);
    }

    clients.set(userId, { userId, socket });
    broadcastPresence();

    // If a call is still ringing for this user (e.g. they just opened the app
    // from a push notification), replay the incoming call so they can answer it.
    const now = Date.now();
    for (const c of calls) {
      if (
        c.calleeId === userId &&
        c.status === "ringing" &&
        now - c.startedAt < 60_000
      ) {
        const caller = getUser(c.callerId);
        if (caller)
          send(userId, "call:incoming", {
            callId: c.id,
            callType: c.type,
            caller: { id: caller.id, name: caller.name, avatar: caller.avatar },
          });
      }
    }

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
        const incoming = {
          callId: payload.callId,
          callType: payload.callType,
          // identity travels with the call:
          caller: { id: caller.id, name: caller.name, avatar: caller.avatar },
        };
        send(payload.calleeId, "call:incoming", incoming);
        // Also push a system notification so the callee is alerted even when
        // they're not on the site (browser running in the background).
        void sendPush(payload.calleeId, {
          title: `${caller.avatar} ${caller.name} is calling…`,
          body: payload.callType === "video" ? "Video call" : "Voice call",
          url: "/",
        });
      } else if (type === "call:accept") {
        markCall(payload.callId, "accepted");
        send(payload.toUserId, "call:accepted", { callId: payload.callId });
      } else if (type === "call:dismiss") {
        markCall(payload.callId, "dismissed_busy");
        send(payload.toUserId, "call:dismissed", {
          callId: payload.callId,
          reason: payload.reason ?? "busy",
        });
      } else if (type === "call:hangup") {
        markCall(payload.callId, "ended");
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
      } else if (type === "call:recording") {
        // Let the other party know a recording started/stopped (shown to both).
        send(payload.toUserId, "call:recording", {
          on: !!payload.on,
          fromUserId: userId,
        });
      }
    });

    socket.on("close", () => {
      // Ignore if a newer connection already replaced this socket.
      if (clients.get(userId)?.socket !== socket) return;
      clients.delete(userId);
      broadcastPresence();
      // Grace period: only end this user's active calls if they DON'T reconnect
      // within a few seconds. A brief network blip or page reload shouldn't drop
      // a live call — but a real tab close / hang-up still ends it for both.
      const timer = setTimeout(() => {
        disconnectTimers.delete(userId);
        if (!clients.has(userId)) endActiveCalls(userId);
      }, 8000);
      disconnectTimers.set(userId, timer);
    });
  });
}
