// Mirrors the server domain model (CLAUDE.md §6).
export interface User {
  id: string;
  name: string;
  avatar: string;
}

export type CallType = "voice" | "video";

export interface IncomingCall {
  callId: string;
  callType: CallType;
  caller: User; // the REAL caller — identity travels with the call
}

export interface Message {
  id: string;
  threadId: string;
  senderId: string;
  body: string;
  kind: "text" | "quick_reply" | "recording";
  mediaUrl?: string; // for kind: "recording"
  summary?: string; // AI summary of a recording, once generated
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
  weekStart: number;
  content: string;
}
