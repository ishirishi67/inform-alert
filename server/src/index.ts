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
  todos,
  users,
} from "./store.js";
import type { CallbackReminder, Message, WeeklyTodo } from "./types.js";
import { attachWs, send } from "./ws.js";
import { addSubscription, getPublicKey, initPush } from "./push.js";
import { getRecordingBuffer, saveRecording } from "./recordings.js";
import { generateTodos, summarize, transcribe } from "./summarize.js";
import {
  dbEnabled,
  initDb,
  loadAll,
  persistCall,
  persistMessage,
  persistTodo,
} from "./db.js";

initPush();

// Load any persisted data into the in-memory working set on boot.
await initDb();
{
  const saved = await loadAll();
  calls.push(...saved.calls);
  messages.push(...saved.messages);
  todos.push(...saved.todos);
  console.log(
    `[InformAlert] storage: ${dbEnabled ? "database (durable)" : "in-memory (resets on restart)"}` +
      ` — loaded ${saved.calls.length} calls, ${saved.messages.length} messages`
  );
}

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
  persistCall(call);
  res.json({ call });
});

app.patch("/api/calls/:id", (req, res) => {
  const call = calls.find((c) => c.id === req.params.id);
  if (!call) return res.status(404).json({ error: "not found" });
  Object.assign(call, req.body);
  if (["ended", "missed", "dismissed_busy"].includes(call.status))
    call.endedAt = Date.now();
  persistCall(call);
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
  persistMessage(msg);
  send(recipientId, "message:new", msg); // live-deliver
  res.json({ message: msg });
});

// --- Call recordings (upload + serve) -------------------------------------
// The recorder uploads the WebM blob here; the chat message then references the
// returned URL so the other person can play it.
app.post(
  "/api/recordings",
  express.raw({ type: () => true, limit: "60mb" }),
  async (req, res) => {
    const buf = req.body as Buffer;
    if (!buf || !buf.length) return res.status(400).json({ error: "empty" });
    const recId = id("rec");
    await saveRecording(recId, buf, String(req.headers["content-type"] || "video/webm"));
    res.json({ url: `/api/recordings/${recId}` });
  }
);

// Serve a recording with HTTP range support — <video>/<audio> elements need
// 206 Partial Content responses to play and seek reliably.
app.get("/api/recordings/:id", async (req, res) => {
  const rec = await getRecordingBuffer(req.params.id);
  if (!rec) return res.status(404).end();
  const { buffer, mime } = rec;
  const total = buffer.length;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mime);

  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end = match && match[2] ? parseInt(match[2], 10) : total - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", end - start + 1);
    res.end(buffer.subarray(start, end + 1));
  } else {
    res.setHeader("Content-Length", total);
    res.end(buffer);
  }
});

// Transcribe + summarize a recording message, then attach the summary and push
// the updated message to both participants.
app.post("/api/messages/:id/summarize", async (req, res) => {
  const msg = messages.find((m) => m.id === req.params.id);
  if (!msg || msg.kind !== "recording" || !msg.mediaUrl)
    return res.status(404).json({ error: "not a recording message" });
  const recId = msg.mediaUrl.split("/").pop() ?? "";
  const rec = await getRecordingBuffer(recId);
  if (!rec)
    return res.status(410).json({ error: "this recording is no longer available" });
  try {
    const transcript = await transcribe(rec.buffer, rec.mime);
    msg.transcript = transcript; // saved for reuse in weekly to-dos
    msg.summary = transcript
      ? await summarize(transcript)
      : "No speech was detected in this recording.";
    persistMessage(msg);
    const [a, b] = msg.threadId.split(":");
    send(a, "message:update", msg);
    send(b, "message:update", msg);
    res.json({ message: msg });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// --- Call history ---------------------------------------------------------
// A durable log of every call this user was part of.
app.get("/api/history", (req, res) => {
  const meId = String(req.query.userId ?? "");
  if (!getUser(meId)) return res.status(400).json({ error: "bad user" });
  const log = calls
    .filter((c) => c.callerId === meId || c.calleeId === meId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((c) => {
      const otherId = c.callerId === meId ? c.calleeId : c.callerId;
      const other = getUser(otherId);
      return {
        id: c.id,
        direction: c.callerId === meId ? "outgoing" : "incoming",
        other: other ? { name: other.name, avatar: other.avatar } : null,
        type: c.type,
        status: c.status,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
      };
    });
  res.json({ calls: log });
});

// --- Weekly to-dos --------------------------------------------------------
// Generate a to-do list from the past week's calls/messages for a user.
app.get("/api/todos", (req, res) => {
  const meId = String(req.query.userId ?? "");
  if (!getUser(meId)) return res.status(400).json({ error: "bad user" });
  const mine = todos
    .filter((t) => t.userId === meId)
    .sort((a, b) => b.generatedAt - a.generatedAt);
  res.json({ todos: mine });
});

app.post("/api/todos/generate", async (req, res) => {
  const meId = req.body?.userId;
  const me = getUser(meId);
  if (!me) return res.status(400).json({ error: "bad user" });
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const material = messages
    .filter((m) => m.threadId.split(":").includes(meId) && m.createdAt >= weekAgo)
    .map((m) => {
      const who = getUser(m.senderId)?.name ?? m.senderId;
      if (m.kind === "recording" && (m.summary || m.transcript))
        return `Call recording (with ${who}) — summary: ${m.summary ?? ""}\nTranscript: ${m.transcript ?? ""}`;
      return `${who}: ${m.body}`;
    })
    .join("\n\n");

  if (!material.trim())
    return res.json({ todo: null, note: "No call or message activity in the last week." });

  try {
    const content = await generateTodos(me.name, material);
    const todo: WeeklyTodo = {
      id: id("todo"),
      userId: meId,
      generatedAt: Date.now(),
      weekStart: weekAgo,
      content,
    };
    todos.push(todo);
    persistTodo(todo);
    res.json({ todo });
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
