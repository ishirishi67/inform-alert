// In-memory store for v1 scaffold. Seeds one family circle so the app runs
// immediately. Replace with PostgreSQL-backed repositories later (CLAUDE.md §6).
import type {
  Call,
  CallbackReminder,
  Circle,
  Message,
  User,
  WeeklyTodo,
} from "./types.js";

let seq = 0;
export const id = (prefix: string) => `${prefix}_${++seq}`;

export const users: User[] = [
  { id: "u_kid", name: "Ishi", avatar: "👧" },
  { id: "u_mom", name: "Mom", avatar: "👩" },
  { id: "u_dad", name: "Dad", avatar: "👨" },
];

export const circles: Circle[] = [
  { id: "c_family", name: "Family", memberIds: users.map((u) => u.id) },
];

export const calls: Call[] = [];
export const messages: Message[] = [];
export const reminders: CallbackReminder[] = [];
export const todos: WeeklyTodo[] = [];

export const getUser = (uid: string) => users.find((u) => u.id === uid);

// Canonical, order-independent thread key for a 1:1 conversation.
export const threadId = (a: string, b: string) => [a, b].sort().join(":");
