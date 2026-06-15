// HTTP API + WebSocket bootstrap. REST handles CRUD (auth/circle/messages/
// reminders); the WebSocket hub (ws.ts) handles live presence + call signaling.
// Real-time A/V media is delegated to a managed WebRTC provider later (CLAUDE.md §6).
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import {
  calls,
  circles,
  getUser,
  id,
  messages,
  reminders,
  threadId,
  users,
} from "./store.js";
import type { CallbackReminder, Message } from "./types.js";
import { attachWs, send } from "./ws.js";
import { addSubscription, getPublicKey, initPush } from "./push.js";
import { getRecording, getRecordingBuffer, saveRecording } from "./recordings.js";
import { summarize, transcribe } from "./summarize.js";

initPush();

const app = express();
app.use(cors());
app.use(express.json());

// --- Auth (stubbed) -------------------------------------------------------
// v1 scaffold: "log in" simply selects an existing seeded family member.
// Replace with Google Sign-In (which also unlocks Calendar access) later.
app.post("/api/login", (req, res) => {
  const user = getUser(req.body?.userId);
  if (!user) return res.status(404).json({ error: "unknown user" });
  res.json({ user });
});

// --- Family circle --------------------------------------------------------
app.get("/api/me/circle", (req, res) => {
  const meId = String(req.query.userId ?? "");
  const circle = circles.find((c) => c.memberIds.includes(meId));
  if (!circle) return res.status(404).json({ error: "no circle" });
  const members = circle.memberIds
    .filter((uid) => uid !== meId)
    .map((uid) => getUser(uid));
  res.json({ circle: { id: circle.id, name: circle.name }, members });
});

// --- Calls (records the lifecycle; signaling itself is over WS) -----------
app.post("/api/calls", (req, res) => {
  const { callerId, calleeId, type } = req.body ?? {};
  if (!getUser(callerId) || !getUser(calleeId))
    return res.status(400).json({ error: "bad participants" });
  const call = {
    id: id("call"),
    callerId,
    calleeId,
    type,
    status: "ringing" as const,
    startedAt: Date.now(),
  };
  calls.push(call);
  res.json({ call });
});

app.patch("/api/calls/:id", (req, res) => {
  const call = calls.find((c) => c.id === req.params.id);
  if (!call) return res.status(404).json({ error: "not found" });
  Object.assign(call, req.body);
  if (["ended", "missed", "dismissed_busy"].includes(call.status))
    call.endedAt = Date.now();
  res.json({ call });
});

// --- Messages -------------------------------------------------------------
app.get("/api/messages", (req, res) => {
  const { a, b } = req.query as { a: string; b: string };
  const tid = threadId(a, b);
  res.json({ messages: messages.filter((m) => m.threadId === tid) });
});

app.post("/api/messages", (req, res) => {
  const { senderId, recipientId, body, kind, mediaUrl } = req.body ?? {};
  if (!getUser(senderId) || !getUser(recipientId))
    return res.status(400).json({ error: "bad users" });
  const msgKind: Message["kind"] =
    kind === "quick_reply"
      ? "quick_reply"
      : kind === "recording"
        ? "recording"
        : "text";
  const msg: Message = {
    id: id("msg"),
    threadId: threadId(senderId, recipientId),
    senderId,
    body,
    kind: msgKind,
    ...(mediaUrl ? { mediaUrl } : {}),
    createdAt: Date.now(),
  };
  messages.push(msg);
  send(recipientId, "message:new", msg); // live-deliver
  res.json({ message: msg });
});

// --- Call recordings (upload + serve) -------------------------------------
// The recorder uploads the WebM blob here; the chat message then references the
// returned URL so the other person can play it.
app.post(
  "/api/recordings",
  express.raw({ type: () => true, limit: "60mb" }),
  (req, res) => {
    const buf = req.body as Buffer;
    if (!buf || !buf.length) return res.status(400).json({ error: "empty" });
    const recId = id("rec");
    saveRecording(recId, buf, String(req.headers["content-type"] || "video/webm"));
    res.json({ url: `/api/recordings/${recId}` });
  }
);

app.get("/api/recordings/:id", (req, res) => {
  const r = getRecording(req.params.id);
  if (!r) return res.status(404).end();
  res.setHeader("Content-Type", r.mime);
  r.stream.pipe(res);
});

// Transcribe + summarize a recording message, then attach the summary and push
// the updated message to both participants.
app.post("/api/messages/:id/summarize", async (req, res) => {
  const msg = messages.find((m) => m.id === req.params.id);
  if (!msg || msg.kind !== "recording" || !msg.mediaUrl)
    return res.status(404).json({ error: "not a recording message" });
  const recId = msg.mediaUrl.split("/").pop() ?? "";
  const rec = getRecordingBuffer(recId);
  if (!rec)
    return res.status(410).json({ error: "this recording is no longer available" });
  try {
    const transcript = await transcribe(rec.buffer, rec.mime);
    msg.summary = transcript
      ? await summarize(transcript)
      : "No speech was detected in this recording.";
    const [a, b] = msg.threadId.split(":");
    send(a, "message:update", msg);
    send(b, "message:update", msg);
    res.json({ message: msg });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// --- Callback reminders ---------------------------------------------------
// "When my meeting ends" (calendar) OR "Remind me in…" (delay). Calendar source
// is stubbed here; wire to Google Calendar to read the real meeting end time.
app.post("/api/reminders", (req, res) => {
  const { forUserId, aboutCallId, source, delayMs } = req.body ?? {};
  if (!getUser(forUserId)) return res.status(400).json({ error: "bad user" });
  const triggerAt = Date.now() + (Number(delayMs) || 10 * 60 * 1000);
  const reminder: CallbackReminder = {
    id: id("rem"),
    forUserId,
    aboutCallId,
    triggerAt,
    source: source === "calendar" ? "calendar" : "delay",
    status: "scheduled",
  };
  reminders.push(reminder);

  // Fire a "call back now" nudge at trigger time (in-process timer for the scaffold).
  const wait = Math.max(0, triggerAt - Date.now());
  setTimeout(() => {
    if (reminder.status !== "scheduled") return;
    reminder.status = "fired";
    const call = calls.find((c) => c.id === aboutCallId);
    const other = call ? getUser(call.callerId) : undefined;
    send(forUserId, "reminder:callback", {
      reminderId: reminder.id,
      callBack: other ? { id: other.id, name: other.name } : null,
    });
  }, wait);

  res.json({ reminder });
});

// --- Web Push (notify even when the app isn't open) -----------------------
app.get("/api/push/public-key", (_req, res) => res.json({ key: getPublicKey() }));

app.post("/api/push/subscribe", (req, res) => {
  const { userId, subscription } = req.body ?? {};
  if (!getUser(userId) || !subscription?.endpoint)
    return res.status(400).json({ error: "bad subscription" });
  addSubscription(userId, subscription);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, users }));

// --- Serve the built web app (production / single-service deploy) ----------
// In dev, Vite serves the client on :5173 and proxies here, so this is skipped.
// On Render we build the web app and serve it from this same Node process, so
// the API, WebSocket, and UI all share one origin (no CORS / cross-origin WS).
const __dirname = dirname(fileURLToPath(import.meta.url));
const webDist = join(__dirname, "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback: any non-API GET returns index.html.
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
  console.log(`[InformAlert] Serving web app from ${webDist}`);
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
attachWs(wss);

const PORT = Number(process.env.PORT ?? 4000);
server.listen(PORT, () =>
  console.log(`[InformAlert] API + WS listening on http://localhost:${PORT}`)
);
