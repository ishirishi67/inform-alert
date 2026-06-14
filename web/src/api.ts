import type { Message, User } from "./types";

const json = (r: Response) => {
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

export const api = {
  login: (userId: string): Promise<{ user: User }> =>
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    }).then(json),

  circle: (userId: string): Promise<{ members: User[] }> =>
    fetch(`/api/me/circle?userId=${userId}`).then(json),

  createCall: (callerId: string, calleeId: string, type: string) =>
    fetch("/api/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callerId, calleeId, type }),
    }).then(json),

  updateCall: (id: string, patch: object) =>
    fetch(`/api/calls/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json),

  messages: (a: string, b: string): Promise<{ messages: Message[] }> =>
    fetch(`/api/messages?a=${a}&b=${b}`).then(json),

  sendMessage: (
    senderId: string,
    recipientId: string,
    body: string,
    kind: "text" | "quick_reply"
  ) =>
    fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId, recipientId, body, kind }),
    }).then(json),

  // source: "calendar" => when meeting ends; "delay" => "Remind me in…"
  scheduleReminder: (
    forUserId: string,
    aboutCallId: string,
    source: "calendar" | "delay",
    delayMs: number
  ) =>
    fetch("/api/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forUserId, aboutCallId, source, delayMs }),
    }).then(json),
};
