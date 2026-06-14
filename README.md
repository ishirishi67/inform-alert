# InformAlert

Identity-aware family calling app — **the caller is the person, not the phone.**
See [CLAUDE.md](./CLAUDE.md) for the full product spec. This repo is the v1 web-first scaffold.

## What runs today

A working demo of the **core v1 insight**:

- Pick who you are (You / Mom / Dad) — each is a person, not a device.
- Call a family member → the callee sees a ringing screen with **the real caller's name + avatar** (identity travels with the call over WebSocket signaling).
- Callee taps **Busy** → quick replies or a typed message, then **"Remind me to call back"**
  (*"When my meeting ends"* or *"Remind me in…"* 10 min / 30 min / 1 hour).
- The reminder fires a **"⏰ Time to call back"** nudge at the chosen time.
- 1:1 **text chat with history**, live-delivered.

> Stubbed for v1 scaffold: real WebRTC audio/video media (delegate to a managed
> provider — LiveKit/Twilio/Daily/Agora), Google Sign-In + Calendar, PostgreSQL,
> web push. See the `TODO`/comments in code and CLAUDE.md §6.

## Prerequisites

- **Node.js 20+** and npm. (Not detected on this machine — install from https://nodejs.org first.)

## Run it

```bash
npm install          # installs root + server + web workspaces
npm run dev          # starts API/WS (:4000) and web (:5173) together
```

Then open **http://localhost:5173** in two browser tabs (or two devices on your LAN):
log in as **Dad** in one and **You** in the other, then call Dad from the "You" tab.

### Run pieces separately
```bash
npm run dev:server   # http://localhost:4000  (REST + /ws)
npm run dev:web      # http://localhost:5173
```

## Layout

```
inform-alert/
├─ CLAUDE.md            # product spec (source of truth)
├─ server/              # Node + TypeScript: REST API + WebSocket signaling
│  └─ src/
│     ├─ index.ts       # HTTP routes + WS bootstrap
│     ├─ ws.ts          # presence + call signaling (carries caller identity)
│     ├─ store.ts       # in-memory store (swap for PostgreSQL later)
│     └─ types.ts       # domain model
└─ web/                 # React + Vite + TypeScript
   └─ src/
      ├─ App.tsx        # shell: circle, calling, chat, modals
      ├─ components/BusyReply.tsx   # the "busy → remind me" flow
      ├─ api.ts  ws.ts  types.ts
      └─ styles.css
```

## Next steps (from CLAUDE.md §6)

1. Swap the stubbed login for **Google Sign-In** (also unlocks Calendar).
2. Wire **WebRTC** media via a managed provider for real voice/video.
3. Replace the in-memory store with **PostgreSQL**.
4. Read real meeting end times from **Google Calendar** for the callback trigger.
5. Add **web push** so incoming calls/reminders reach a backgrounded tab.
