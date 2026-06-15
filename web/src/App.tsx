import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { connectWs } from "./ws";
import { PeerCall } from "./webrtc";
import { Ringtone } from "./ringtone";
import { CallRecorder } from "./recorder";
import { setupPush } from "./push";
import { BusyReply } from "./components/BusyReply";
import { CallScreen } from "./components/CallScreen";
import type {
  CallLogEntry,
  CallType,
  IncomingCall,
  Message,
  User,
  WeeklyTodo,
} from "./types";

type WsClient = ReturnType<typeof connectWs>;
type ActiveCall = { id: string; peer: User; type: CallType; outgoing: boolean };

// Save a recorded Blob to the user's device.
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// The three seeded family members (CLAUDE.md §3). "Login" = pick who you are.
const SEED_USERS: User[] = [
  { id: "u_kid", name: "Ishi", avatar: "👧" },
  { id: "u_mom", name: "Mom", avatar: "👩" },
  { id: "u_dad", name: "Dad", avatar: "👨" },
];

export function App() {
  const [me, setMe] = useState<User | null>(null);
  const [members, setMembers] = useState<User[]>([]);
  const [online, setOnline] = useState<string[]>([]);
  const [active, setActive] = useState<User | null>(null); // who I'm chatting with
  const [view, setView] = useState<"chat" | "activity">("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [busyFor, setBusyFor] = useState<IncomingCall | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Active call + live media state
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connState, setConnState] = useState<RTCPeerConnectionState>("new");
  const [recording, setRecording] = useState(false);
  const [remoteRecording, setRemoteRecording] = useState(false);
  const [pendingRec, setPendingRec] = useState<{
    blob: Blob;
    url: string;
    peer: User;
  } | null>(null);
  const callRef = useRef<PeerCall | null>(null);
  const recRef = useRef<CallRecorder | null>(null);
  const recPeerRef = useRef<User | null>(null); // who the recording is with
  const ws = useRef<WsClient | null>(null);
  const ringRef = useRef<Ringtone | null>(null);
  if (!ringRef.current) ringRef.current = new Ringtone();

  // Dismiss the "X is calling…" system notification (shown by the service worker).
  const closeCallNotif = () => {
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.ready
        .then((reg) => reg.getNotifications({ tag: "inform-alert-call" }))
        .then((ns) => ns.forEach((n) => n.close()))
        .catch(() => {});
  };

  // Stop recording and offer to send/save it. Works even if the call has ended,
  // since we captured the peer when recording started (avoids stale state).
  const finishRecording = () => {
    const rec = recRef.current;
    const peer = recPeerRef.current;
    recRef.current = null;
    recPeerRef.current = null;
    setRecording(false);
    setRemoteRecording(false);
    if (rec)
      rec.stop().then((blob) => {
        if (!blob.size) return;
        if (peer) setPendingRec({ blob, url: URL.createObjectURL(blob), peer });
        else downloadBlob(blob, `informalert-call-${Date.now()}.webm`);
      });
  };

  // Send the just-finished recording to the other person (with an optional note).
  const sendRecording = async (note: string) => {
    if (!pendingRec || !me) return;
    const { blob, peer, url } = pendingRec;
    setPendingRec(null);
    setToast("Sending recording…");
    try {
      const { url: mediaUrl } = await api.uploadRecording(blob);
      const { message } = await api.sendMessage(
        me.id,
        peer.id,
        note.trim() || "📹 Call recording",
        "recording",
        mediaUrl
      );
      // Show it in my own thread too (so the sender sees it was sent).
      setMessages((m) => [...m, message]);
      setToast(`Recording sent to ${peer.name}`);
    } catch {
      setToast("Couldn't send the recording");
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const teardownCall = () => {
    finishRecording();
    callRef.current?.close();
    callRef.current = null;
    setCall(null);
    setIncoming(null); // also clear a still-ringing incoming call
    setLocalStream(null);
    setRemoteStream(null);
    setConnState("new");
    closeCallNotif();
  };

  // Start/stop recording. The other side is told so both see the REC indicator.
  const toggleRecord = async () => {
    if (!call) return;
    if (recording) {
      ws.current?.send("call:recording", { toUserId: call.peer.id, on: false });
      finishRecording();
      return;
    }
    if (!localStream || !remoteStream) {
      setToast("Wait until the call connects, then record");
      return;
    }
    try {
      const rec = new CallRecorder();
      rec.start(localStream, remoteStream, call.type === "video");
      recRef.current = rec;
      recPeerRef.current = call.peer; // remember who, for sending afterwards
      setRecording(true);
      ws.current?.send("call:recording", { toUserId: call.peer.id, on: true });
    } catch {
      setToast("Recording isn't supported on this browser");
    }
  };

  // --- Connect after login -------------------------------------------------
  useEffect(() => {
    if (!me) return;
    api.circle(me.id).then((r) => setMembers(r.members));
    const client = connectWs(me.id, (type, payload) => {
      if (type === "presence") setOnline(payload.online);
      else if (type === "call:incoming") setIncoming(payload);
      // Callee accepted → caller now creates and sends the WebRTC offer.
      else if (type === "call:accepted") callRef.current?.createOffer();
      else if (type === "call:dismissed") {
        teardownCall();
        setToast(`Call dismissed (${payload.reason})`);
      }
      // The other person hung up → tear down and inform this side.
      else if (type === "call:ended") {
        teardownCall();
        setToast("Call ended");
      } else if (type === "webrtc:offer")
        callRef.current?.handleOffer(payload.sdp);
      else if (type === "webrtc:answer")
        callRef.current?.handleAnswer(payload.sdp);
      else if (type === "webrtc:ice")
        callRef.current?.handleIce(payload.candidate);
      else if (type === "call:recording") setRemoteRecording(!!payload.on);
      else if (type === "message:new")
        setMessages((m) => [...m, payload as Message]);
      else if (type === "message:update")
        setMessages((m) =>
          m.map((x) => (x.id === (payload as Message).id ? (payload as Message) : x))
        );
      else if (type === "reminder:callback")
        setToast(`⏰ Time to call ${payload.callBack?.name ?? "back"}`);
    });
    ws.current = client;
    return () => {
      client.close();
      teardownCall();
      ringRef.current?.stop();
    };
  }, [me]);

  // Ring: loop while a call is incoming (callee) or while the caller is still
  // waiting to connect. Only ring back while genuinely connecting — stop on
  // connected, failed, disconnected, dismissed, or ended.
  useEffect(() => {
    const ring = ringRef.current!;
    const connecting = connState === "new" || connState === "connecting";
    const shouldRing = !!incoming || (!!call && call.outgoing && connecting);
    if (shouldRing) {
      ring.start();
      if (incoming) navigator.vibrate?.([500, 300, 500]); // buzz on mobile
    } else {
      ring.stop();
    }
  }, [incoming, call, connState]);

  // If the media connection fails outright, end the call and inform the user.
  useEffect(() => {
    if (call && connState === "failed") {
      setToast("Call connection failed");
      teardownCall();
    }
  }, [call, connState]);

  // Load thread when switching conversations.
  useEffect(() => {
    if (me && active)
      api.messages(me.id, active.id).then((r) => setMessages(r.messages));
  }, [me, active]);

  if (!me) {
    return (
      <div className="login">
        <h1>InformAlert</h1>
        <p>Who's using this device?</p>
        <div className="quick-replies">
          {SEED_USERS.map((u) => (
            <button
              key={u.id}
              className="chip big"
              onClick={() => {
                ringRef.current?.unlock(); // unlock audio within this user gesture
                setupPush(u.id); // register SW + ask notification permission
                setMe(u);
              }}
            >
              {u.avatar} {u.name}
            </button>
          ))}
        </div>
        <small>The call announces the person, not the phone.</small>
      </div>
    );
  }

  const newPeerCall = (peerId: string, callId: string) =>
    new PeerCall(
      (t, p) => ws.current?.send(t, p),
      peerId,
      callId,
      (s) => setRemoteStream(s),
      (st) => setConnState(st)
    );

  const startCall = async (callee: User, type: CallType) => {
    try {
      const { call: c } = await api.createCall(me.id, callee.id, type);
      const pc = newPeerCall(callee.id, c.id);
      callRef.current = pc;
      setLocalStream(await pc.startLocalMedia(type === "video"));
      setCall({ id: c.id, peer: callee, type, outgoing: true });
      ws.current?.send("call:invite", {
        callId: c.id,
        calleeId: callee.id,
        callType: type,
      });
    } catch {
      teardownCall();
      setToast("Couldn't access your microphone / camera");
    }
  };

  const acceptIncoming = async () => {
    if (!incoming) return;
    const inc = incoming;
    setIncoming(null);
    try {
      const pc = newPeerCall(inc.caller.id, inc.callId);
      callRef.current = pc;
      setLocalStream(await pc.startLocalMedia(inc.callType === "video"));
      setCall({ id: inc.callId, peer: inc.caller, type: inc.callType, outgoing: false });
      // Tell the caller we accepted; they will send the offer.
      ws.current?.send("call:accept", {
        callId: inc.callId,
        toUserId: inc.caller.id,
      });
    } catch {
      teardownCall();
      ws.current?.send("call:dismiss", {
        callId: inc.callId,
        toUserId: inc.caller.id,
        reason: "no-media",
      });
      setToast("Couldn't access your microphone / camera");
    }
  };

  const dismissBusy = () => {
    if (!incoming) return;
    ws.current?.send("call:dismiss", {
      callId: incoming.callId,
      toUserId: incoming.caller.id,
      reason: "busy",
    });
    setBusyFor(incoming);
    setIncoming(null);
  };

  // Hang up: notify the other side, then tear down locally.
  const endCall = () => {
    if (call)
      ws.current?.send("call:hangup", {
        callId: call.id,
        toUserId: call.peer.id,
      });
    teardownCall();
  };

  const send = async (body: string) => {
    if (!active || !body.trim()) return;
    const { message } = await api.sendMessage(me.id, active.id, body, "text");
    setMessages((m) => [...m, message]);
  };

  const summarizeMessage = async (id: string) => {
    const { message } = await api.summarizeMessage(id);
    setMessages((m) => m.map((x) => (x.id === message.id ? message : x)));
  };

  return (
    <div className="app">
      <header>
        <span>
          {me.avatar} {me.name}
        </span>
        <button className="link" onClick={() => setMe(null)}>
          Switch
        </button>
      </header>

      <main>
        <aside>
          <div
            className={`member activity-link ${view === "activity" ? "selected" : ""}`}
            onClick={() => setView("activity")}
          >
            📋 History &amp; To-dos
          </div>
          <h3>Family</h3>
          {members.map((u) => (
            <div
              key={u.id}
              className={`member ${
                view === "chat" && active?.id === u.id ? "selected" : ""
              }`}
              onClick={() => {
                setView("chat");
                setActive(u);
              }}
            >
              <span className={`dot ${online.includes(u.id) ? "on" : ""}`} />
              {u.avatar} {u.name}
              <span className="actions">
                <button
                  title="Voice call"
                  onClick={(e) => {
                    e.stopPropagation();
                    startCall(u, "voice");
                  }}
                >
                  📞
                </button>
                <button
                  title="Video call"
                  onClick={(e) => {
                    e.stopPropagation();
                    startCall(u, "video");
                  }}
                >
                  🎥
                </button>
              </span>
            </div>
          ))}
        </aside>

        <section className="thread">
          {view === "activity" ? (
            <ActivityPanel me={me} />
          ) : active ? (
            <Chat
              me={me}
              other={active}
              messages={messages}
              onSend={send}
              onSummarize={summarizeMessage}
            />
          ) : (
            <p className="empty">Pick someone to call or message.</p>
          )}
        </section>
      </main>

      {/* Incoming call — shows the REAL caller */}
      {incoming && (
        <div className="modal">
          <div className="ring">
            <div className="avatar-big">{incoming.caller.avatar}</div>
            <h2>{incoming.caller.name} is calling…</h2>
            <p>{incoming.callType === "video" ? "Video call" : "Voice call"}</p>
            <div className="row center">
              <button className="accept" onClick={acceptIncoming}>
                Accept
              </button>
              <button className="busy" onClick={dismissBusy}>
                Busy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Busy reply + "Remind me in…" flow */}
      {busyFor && (
        <div className="modal">
          <BusyReply me={me} call={busyFor} onDone={() => setBusyFor(null)} />
        </div>
      )}

      {/* Live WebRTC call */}
      {call && (
        <div className="modal">
          <CallScreen
            peer={call.peer}
            callType={call.type}
            localStream={localStream}
            remoteStream={remoteStream}
            connectionState={connState}
            recording={recording}
            remoteRecording={remoteRecording}
            onToggleRecord={toggleRecord}
            onEnd={endCall}
          />
        </div>
      )}

      {/* After recording: preview, add a note, send to the other person */}
      {pendingRec && (
        <div className="modal">
          <SendRecording
            rec={pendingRec}
            onSend={sendRecording}
            onSave={() => {
              downloadBlob(pendingRec.blob, `informalert-call-${Date.now()}.webm`);
              URL.revokeObjectURL(pendingRec.url);
              setPendingRec(null);
            }}
            onDiscard={() => {
              URL.revokeObjectURL(pendingRec.url);
              setPendingRec(null);
            }}
          />
        </div>
      )}

      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function SendRecording({
  rec,
  onSend,
  onSave,
  onDiscard,
}: {
  rec: { url: string; peer: User };
  onSend: (note: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div className="sheet">
      <h3>Recording ready 🎥</h3>
      <video src={rec.url} controls className="rec-preview" />
      <input
        placeholder={`Add a note for ${rec.peer.name}…`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="row">
        <button className="accept" onClick={() => onSend(note)}>
          Send to {rec.peer.avatar} {rec.peer.name}
        </button>
        <button onClick={onSave}>Save to device</button>
      </div>
      <button className="link" onClick={onDiscard}>
        Discard
      </button>
    </div>
  );
}

function Chat({
  me,
  other,
  messages,
  onSend,
  onSummarize,
}: {
  me: User;
  other: User;
  messages: Message[];
  onSend: (body: string) => void;
  onSummarize: (id: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  return (
    <>
      <h3>
        {other.avatar} {other.name}
      </h3>
      <div className="messages">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`bubble ${m.senderId === me.id ? "mine" : ""}`}
          >
            {m.kind === "recording" ? (
              <RecordingMessage m={m} onSummarize={onSummarize} />
            ) : (
              <>
                {m.kind === "quick_reply" ? "⚡ " : ""}
                {m.body}
              </>
            )}
          </div>
        ))}
      </div>
      <div className="row">
        <input
          value={text}
          placeholder="Message…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (onSend(text), setText(""))}
        />
        <button onClick={() => (onSend(text), setText(""))}>Send</button>
      </div>
    </>
  );
}

function ActivityPanel({ me }: { me: User }) {
  const [calls, setCalls] = useState<CallLogEntry[]>([]);
  const [todos, setTodos] = useState<WeeklyTodo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.history(me.id).then((r) => setCalls(r.calls)).catch(() => {});
    api.todos(me.id).then((r) => setTodos(r.todos)).catch(() => {});
  }, [me.id]);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const { todo, note } = await api.generateTodos(me.id);
      if (todo) setTodos((t) => [todo, ...t]);
      else if (note) setError(note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't generate to-dos");
    } finally {
      setLoading(false);
    }
  };

  const fmt = (ms: number) =>
    new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const latest = todos[0];

  return (
    <div className="activity">
      <h3>📋 History &amp; To-dos</h3>

      <div className="todos-card">
        <div className="row between">
          <strong>✨ This week's to-dos</strong>
          <button className="accept" disabled={loading} onClick={generate}>
            {loading ? "Generating…" : "Generate"}
          </button>
        </div>
        {error && <div className="summary-error">{error}</div>}
        {latest ? (
          <div className="summary">
            <small className="muted">Generated {fmt(latest.generatedAt)}</small>
            <div>{latest.content}</div>
          </div>
        ) : (
          <p className="muted">
            Generate a to-do list from this week's calls and messages.
          </p>
        )}
      </div>

      <h4>Call history</h4>
      {calls.length === 0 ? (
        <p className="muted">No calls yet.</p>
      ) : (
        <div className="call-log">
          {calls.map((c) => (
            <div key={c.id} className="log-row">
              <span className="log-icon">
                {c.type === "video" ? "🎥" : "📞"}
              </span>
              <span className="log-dir">
                {c.direction === "outgoing" ? "↗" : "↘"}
              </span>
              <span className="log-name">
                {c.other ? `${c.other.avatar} ${c.other.name}` : "—"}
              </span>
              <span className={`log-status status-${c.status}`}>{c.status}</span>
              <span className="log-time muted">{fmt(c.startedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordingMessage({
  m,
  onSummarize,
}: {
  m: Message;
  onSummarize: (id: string) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      await onSummarize(m.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't summarize");
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <video src={m.mediaUrl} controls className="msg-video" />
      {m.body && <div>{m.body}</div>}
      {m.summary ? (
        <div className="summary">
          <strong>✨ Summary</strong>
          <div>{m.summary}</div>
        </div>
      ) : (
        <button className="chip summarize-btn" disabled={loading} onClick={run}>
          {loading ? "Summarizing…" : "✨ Summarize"}
        </button>
      )}
      {error && <div className="summary-error">{error}</div>}
    </>
  );
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div className="toast" onClick={onClose}>
      {text}
    </div>
  );
}
