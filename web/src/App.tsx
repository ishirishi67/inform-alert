import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { connectWs } from "./ws";
import { PeerCall } from "./webrtc";
import { Ringtone } from "./ringtone";
import { CallRecorder } from "./recorder";
import { setupPush } from "./push";
import { BusyReply } from "./components/BusyReply";
import { CallScreen } from "./components/CallScreen";
import type { CallType, IncomingCall, Message, User } from "./types";

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
  const callRef = useRef<PeerCall | null>(null);
  const recRef = useRef<CallRecorder | null>(null);
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

  // Save an in-progress recording (e.g. when the call ends) to the device.
  const finishRecording = () => {
    const rec = recRef.current;
    recRef.current = null;
    setRecording(false);
    setRemoteRecording(false);
    if (rec)
      rec.stop().then((blob) => {
        if (blob.size) downloadBlob(blob, `informalert-call-${Date.now()}.webm`);
      });
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
          <h3>Family</h3>
          {members.map((u) => (
            <div
              key={u.id}
              className={`member ${active?.id === u.id ? "selected" : ""}`}
              onClick={() => setActive(u)}
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
          {active ? (
            <Chat me={me} other={active} messages={messages} onSend={send} />
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

      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function Chat({
  me,
  other,
  messages,
  onSend,
}: {
  me: User;
  other: User;
  messages: Message[];
  onSend: (body: string) => void;
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
            {m.kind === "quick_reply" ? "⚡ " : ""}
            {m.body}
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
