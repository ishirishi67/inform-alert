import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { connectWs } from "./ws";
import { BusyReply } from "./components/BusyReply";
import type { IncomingCall, Message, User } from "./types";

type WsClient = ReturnType<typeof connectWs>;

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
  const [inCall, setInCall] = useState<IncomingCall | User | null>(null);
  const [busyFor, setBusyFor] = useState<IncomingCall | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const ws = useRef<WsClient | null>(null);

  // --- Connect after login -------------------------------------------------
  useEffect(() => {
    if (!me) return;
    api.circle(me.id).then((r) => setMembers(r.members));
    const client = connectWs(me.id, (type, payload) => {
      if (type === "presence") setOnline(payload.online);
      else if (type === "call:incoming") setIncoming(payload);
      else if (type === "call:accepted") setToast("Call connected");
      else if (type === "call:dismissed") {
        setInCall(null);
        setToast(`Call dismissed (${payload.reason})`);
      }
      else if (type === "message:new")
        setMessages((m) => [...m, payload as Message]);
      else if (type === "reminder:callback")
        setToast(`⏰ Time to call ${payload.callBack?.name ?? "back"}`);
    });
    ws.current = client;
    return () => client.close();
  }, [me]);

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
            <button key={u.id} className="chip big" onClick={() => setMe(u)}>
              {u.avatar} {u.name}
            </button>
          ))}
        </div>
        <small>The call announces the person, not the phone.</small>
      </div>
    );
  }

  const startCall = async (callee: User, type: "voice" | "video") => {
    const { call } = await api.createCall(me.id, callee.id, type);
    ws.current?.send("call:invite", {
      callId: call.id,
      calleeId: callee.id,
      callType: type,
    });
    setInCall(callee);
    setToast(`Calling ${callee.name}…`);
  };

  const acceptIncoming = () => {
    if (!incoming) return;
    ws.current?.send("call:accept", {
      callId: incoming.callId,
      toUserId: incoming.caller.id,
    });
    setInCall(incoming);
    setIncoming(null);
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

  const send = async (body: string) => {
    if (!active || !body.trim()) return;
    const { message } = await api.sendMessage(me.id, active.id, body, "text");
    setMessages((m) => [...m, message]);
  };

  return (
    <div className="app">
      <header>
        <span>{me.avatar} {me.name}</span>
        <button className="link" onClick={() => setMe(null)}>Switch</button>
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
                <button onClick={(e) => { e.stopPropagation(); startCall(u, "voice"); }}>📞</button>
                <button onClick={(e) => { e.stopPropagation(); startCall(u, "video"); }}>🎥</button>
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
              <button className="accept" onClick={acceptIncoming}>Accept</button>
              <button className="busy" onClick={dismissBusy}>Busy</button>
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

      {/* In-call placeholder — real A/V via managed WebRTC provider later */}
      {inCall && (
        <div className="modal">
          <div className="ring">
            <div className="avatar-big">
              {"caller" in inCall ? inCall.caller.avatar : inCall.avatar}
            </div>
            <h2>
              {"caller" in inCall ? inCall.caller.name : inCall.name}
            </h2>
            <p className="muted">Media stream stubbed (WebRTC provider TODO)</p>
            <button className="busy" onClick={() => setInCall(null)}>End</button>
          </div>
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
      <h3>{other.avatar} {other.name}</h3>
      <div className="messages">
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.senderId === me.id ? "mine" : ""}`}>
            {m.kind === "quick_reply" ? "⚡ " : ""}{m.body}
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
  return <div className="toast" onClick={onClose}>{text}</div>;
}
