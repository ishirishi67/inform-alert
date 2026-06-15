// Core domain model — see CLAUDE.md §6. v1 uses an in-memory store;
// swap `store.ts` for PostgreSQL-backed implementations later without touching these types.

export type PresenceState = "available" | "busy" | "in_call" | "offline";
export type CallType = "voice" | "video";
export type CallStatus =
  | "ringing"
  | "accepted"
  | "dismissed_busy"
  | "missed"
  | "ended";
export type MessageKind = "text" | "quick_reply" | "recording";
export type ReminderSource = "calendar" | "delay";
export type ReminderStatus = "scheduled" | "fired" | "cancelled";

export interface User {
  id: string;
  name: string;
  avatar: string; // emoji or URL — identity that travels with the call
  // googleCalendarTokens? — added when Google Calendar integration lands (CLAUDE.md §6)
}

export interface Circle {
  id: string;
  name: string;
  memberIds: string[];
}

export interface Call {
  id: string;
  callerId: string; // identity is ALWAYS resolved from here, never from a device/number
  calleeId: string;
  type: CallType;
  status: CallStatus;
  startedAt: number;
  endedAt?: number;
}

export interface Message {
  id: string;
  threadId: string; // canonical "userA:userB" key, sorted
  senderId: string;
  body: string;
  kind: MessageKind;
  mediaUrl?: string; // for kind: "recording" — URL of the uploaded call recording
  createdAt: number;
}

export interface CallbackReminder {
  id: string;
  forUserId: string; // the busy person who should call back
  aboutCallId: string;
  triggerAt: number;
  source: ReminderSource;
  status: ReminderStatus;
}
