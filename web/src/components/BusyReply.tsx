import { useState } from "react";
import { api } from "../api";
import type { IncomingCall, User } from "../types";

const QUICK_REPLIES = [
  "Busy, will call you back",
  "In a meeting",
  "Call me in 10 min",
];

// "Remind me in…" options + the calendar-driven option (CLAUDE.md §5.2).
const REMIND_OPTIONS: { label: string; source: "calendar" | "delay"; ms: number }[] =
  [
    { label: "When my meeting ends", source: "calendar", ms: 0 },
    { label: "In 10 min", source: "delay", ms: 10 * 60 * 1000 },
    { label: "In 30 min", source: "delay", ms: 30 * 60 * 1000 },
    { label: "In 1 hour", source: "delay", ms: 60 * 60 * 1000 },
  ];

export function BusyReply({
  me,
  call,
  onDone,
}: {
  me: User;
  call: IncomingCall;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState("");

  const reply = async (body: string, kind: "text" | "quick_reply") => {
    if (!body.trim()) return;
    await api.sendMessage(me.id, call.caller.id, body, kind);
  };

  const scheduleAndClose = async (source: "calendar" | "delay", ms: number) => {
    await api.scheduleReminder(me.id, call.callId, source, ms);
    onDone();
  };

  return (
    <div className="sheet">
      <h3>
        Busy? Tell {call.caller.name} {call.caller.avatar}
      </h3>

      <div className="quick-replies">
        {QUICK_REPLIES.map((q) => (
          <button key={q} className="chip" onClick={() => reply(q, "quick_reply")}>
            {q}
          </button>
        ))}
      </div>

      <div className="row">
        <input
          placeholder="Type a message…"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button onClick={() => reply(typed, "text").then(() => setTyped(""))}>
          Send
        </button>
      </div>

      <h4>Remind me to call back</h4>
      <div className="quick-replies">
        {REMIND_OPTIONS.map((r) => (
          <button
            key={r.label}
            className="chip"
            onClick={() => scheduleAndClose(r.source, r.ms)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <button className="link" onClick={onDone}>
        Dismiss without reminder
      </button>
    </div>
  );
}
