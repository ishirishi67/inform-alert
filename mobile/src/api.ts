// Talks to the same backend the web app uses. The mobile app is just another
// client of the InformAlert API + WebSocket.
export const BASE = "https://inform-alert.onrender.com";

export type CallType = "voice" | "video";

export interface User {
  id: string;
  name: string;
  avatar: string;
}

export interface Message {
  id: string;
  threadId: string;
  senderId: string;
  body: string;
  kind: "text" | "quick_reply" | "recording";
  mediaUrl?: string;
  summary?: string;
  transcript?: string;
  createdAt: number;
}

export interface CallLogEntry {
  id: string;
  direction: "incoming" | "outgoing";
  other: { name: string; avatar: string } | null;
  type: CallType;
  status: string;
  startedAt: number;
  endedAt?: number;
}

export interface WeeklyTodo {
  id: string;
  userId: string;
  generatedAt: number;
  content: string;
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  circle: (userId: string) =>
    fetch(`${BASE}/api/me/circle?userId=${userId}`).then((r) =>
      json<{ members: User[] }>(r)
    ),

  messages: (a: string, b: string) =>
    fetch(`${BASE}/api/messages?a=${a}&b=${b}`).then((r) =>
      json<{ messages: Message[] }>(r)
    ),

  sendMessage: (senderId: string, recipientId: string, body: string) =>
    fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId, recipientId, body, kind: "text" }),
    }).then((r) => json<{ message: Message }>(r)),

  summarize: (id: string) =>
    fetch(`${BASE}/api/messages/${id}/summarize`, { method: "POST" }).then((r) =>
      json<{ message: Message }>(r)
    ),

  history: (userId: string) =>
    fetch(`${BASE}/api/history?userId=${userId}`).then((r) =>
      json<{ calls: CallLogEntry[] }>(r)
    ),

  todos: (userId: string) =>
    fetch(`${BASE}/api/todos?userId=${userId}`).then((r) =>
      json<{ todos: WeeklyTodo[] }>(r)
    ),

  generateTodos: (userId: string) =>
    fetch(`${BASE}/api/todos/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    }).then((r) => json<{ todo: WeeklyTodo | null; note?: string }>(r)),
};

export const SEED_USERS: User[] = [
  { id: "u_kid", name: "Ishi", avatar: "👧" },
  { id: "u_mom", name: "Mom", avatar: "👩" },
  { id: "u_dad", name: "Dad", avatar: "👨" },
];
