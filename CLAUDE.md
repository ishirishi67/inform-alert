# CLAUDE.md — InformAlert (working title)

> Specification & engineering guide for an identity-aware family calling app.
> This file is the source of truth for what we are building and how. Read it before writing code.

---

## 1. Product Vision

**The problem (real, specific):** In families that share a phone, the *device* is the identity. When a child calls Dad from Mom's phone, Dad's screen says "Mom" — so if he's busy he ignores it, not realizing it's actually his kid who needs him.

**The fix:** A small, closed **family-circle** app where **the caller's identity travels with the call**, independent of which device is used. Dad always knows *who* is really calling. If he's busy, he can dismiss with a tap and the app **reminds him to call back the moment he's free** — tied into his calendar.

**One-sentence pitch:** _WhatsApp for one family, where the person — not the phone — is the caller, and "I'm busy, I'll call you back" actually happens._

**Primary user & first scenario:** The product owner (a child) calls Mom and Dad from an iPad. Each family member has their **own device**. Dad is often in meetings.

---

## 2. Core Principles (do not violate)

1. **Identity is per-person, not per-device.** A user logs into *their* account; the call announces *them*. Never derive caller identity from a phone number or device.
2. **Closed circle.** No public discovery, no strangers. Members are added manually by invite. The entire address book is the family.
3. **"Busy" is a first-class, finished workflow** — not just a missed call. A dismissed call must always result in either an immediate reply or a scheduled callback reminder. A call should never just vanish.
4. **Web first.** v1 ships as a responsive web app. Native iOS/Android come later. Do not add platform-specific code that blocks the web target.
5. **Ship the roof, not the pool.** Respect the v1 scope in §4. Anything in "Later" is out of bounds for v1 unless explicitly re-scoped.

---

## 3. Personas & Identity Model

| Persona | Device (v1 reality) | Needs |
|---|---|---|
| **The Caller** (child) | iPad / web | Knows their call will be clearly attributed to them; can reach Mom and Dad. |
| **The Busy Parent** (Dad) | Own phone/web | Instantly sees *who* is really calling; can dismiss-with-reason in one tap; gets reminded to call back when free. |
| **The Other Parent** (Mom) | Own device | Same calling/messaging abilities; full circle member. |

- Each person = **one account** = one identity, usable from any device they log into.
- A **Family Circle** is the unit of trust. Every member can call/message every other member. (v1 assumes a single circle.)
- Calls and messages render as **"[Name] is calling…"** — name + avatar, sourced from the account, never the device.

---

## 4. Scope — v1 vs. Later (authoritative)

### ✅ v1 — Build now
- **Accounts & auth** — one identity per person, login from any device.
- **Family Circle** — invite-based membership; manually add the 3–4 people.
- **Identity-aware calling** — 1:1 **voice and video** calls; callee always sees the real caller.
- **1:1 text messaging** with persistent chat history.
- **"Busy" reply flow** — on an incoming call the callee can dismiss with:
  - **Quick replies** (one tap): e.g. _"Busy, will call you back"_, _"In a meeting"_, _"Call me in 10 min"_.
  - **Free-typed message**.
- **Callback reminders via Google Calendar** — when Dad dismisses as busy, the app schedules a reminder to call back **when his current meeting ends** (Google Calendar integration), and/or after a chosen delay.
- **"Now available" notification** — caller is pinged when the busy person becomes free (meeting ends), and the busy person is reminded to return the call.

### 🕒 Later — Explicitly OUT of v1
- Group calls (3+ participants)
- Photo / video / file sharing in chat
- Read receipts ("seen ✓✓")
- Contact discovery / search for new people
- Native iOS & Android apps (web first)
- Multiple family circles per user

> If a task requires a "Later" feature, stop and flag it — do not silently build it.

---

## 5. Key Workflows

### 5.1 Identity-aware call
1. Caller opens app (logged in as themselves on any device) → selects family member → starts **voice or video** call.
2. Callee's device rings showing **caller's name + avatar** (the call's identity), regardless of device.
3. Callee **Accepts** → real-time A/V session. Or **Dismisses** → go to 5.2.

### 5.2 "Busy — I'll call you back"
1. Callee taps **Dismiss / Busy**.
2. Chooses a **quick reply** or **types a message** → sent instantly to caller's chat.
3. App offers to **schedule a callback reminder**:
   - **"When my meeting ends"** → reads the callee's current Google Calendar event end time.
   - **"Remind me in…"** → user picks a delay (e.g. 10 min / 30 min / 1 hour / custom).
4. Caller sees the busy message immediately and (optionally) "Dad will call you back at ~3:30pm."

### 5.3 Callback reminder & "now available"
1. At the trigger time (meeting end / delay), the busy person gets a **notification: "Call [Name] back now."**
2. The original caller optionally gets a **"[Name] is now free"** ping.
3. One tap from the reminder re-initiates the call.

### 5.4 Messaging
- Standard 1:1 threaded chat with history, usable independently of calls. Quick-reply/busy messages land in the same thread.

---

## 6. Architecture (recommended starting point)

> Recommendations, not mandates — but deviations should be justified in a PR.

- **Frontend:** React (web, responsive/mobile-friendly) — PWA-capable so it feels app-like and can later wrap into native. TypeScript throughout.
- **Backend/API:** Node.js (TypeScript). REST/GraphQL for CRUD; **WebSocket** channel for presence, signaling, and live message delivery.
- **Real-time calls (voice/video):** **WebRTC** for the media; a managed SFU/provider (e.g. LiveKit, Twilio, Daily, or Agora) to avoid building NAT traversal/media infra in v1. The provider must support web first.
- **Signaling & presence:** WebSocket service that brokers call offers/answers and carries the **caller-identity payload** (caller userId → resolved to name/avatar server-side; never trust device).
- **Messaging & history:** Persistent store (PostgreSQL) for users, circles, messages, call events, reminders.
- **Auth:** Email/passwordless or OAuth (Google sign-in pairs naturally with Calendar). One account per person.
- **Google Calendar integration:** OAuth scope for reading the busy user's current/next event end time to schedule callbacks. Store tokens securely; refresh handling required.
- **Notifications:** Web Push (and in-app) for incoming calls, busy replies, callback reminders, and "now available."

### Data model (minimum entities)
- `User` (id, name, avatar, auth, googleCalendarTokens?)
- `Circle` + `CircleMembership`
- `Call` (callerId, calleeId, type: voice|video, status: ringing|accepted|dismissed_busy|missed|ended, startedAt, endedAt)
- `Message` (threadId, senderId, body, createdAt, kind: text|quick_reply)
- `CallbackReminder` (forUserId, aboutCallId, triggerAt, source: calendar|delay, status)
- `Presence` (userId, state: available|busy|in_call, source)

---

## 7. Non-Functional Requirements
- **Latency:** call setup (ring → connect) under ~3s on a normal connection.
- **Reliability:** a dismissed call must *always* persist a `Call` record and a follow-up (message and/or reminder). No silent drops.
- **Privacy:** family data is private to the circle. Calendar data used only to compute callback timing — never shared with other members beyond a coarse "~3:30pm" estimate.
- **Security:** encrypt media in transit (WebRTC DTLS-SRTP); protect API with per-user auth; least-privilege Google scopes.
- **Accessibility:** large tap targets, clear caller name/photo, works on tablet (iPad) and phone web browsers.

---

## 8. Definition of Done (v1)
- [ ] A user can sign in as themselves on any device and appear by name to others.
- [ ] Caller can place 1:1 **voice and video** calls; callee sees the **real caller's** name/avatar.
- [ ] Callee can **Accept**, or **Dismiss with a quick reply or typed message**.
- [ ] Busy dismissal can **schedule a callback** ("when meeting ends" via Google Calendar, or **"Remind me in…"** a chosen delay).
- [ ] Busy person receives a **"call back now"** reminder at trigger time; caller optionally gets **"now free"**.
- [ ] 1:1 **text chat with history** works independently and houses busy replies.
- [ ] Runs as a responsive **web app**; no blockers to later native wrap.
- [ ] None of the "Later" features are present.

---

## 9. Open Questions / Future
- App name & branding (working title: *InformAlert*).
- Calendar providers beyond Google (Outlook/Apple) — later.
- How "busy" auto-detects (manual vs. calendar-driven presence) — start manual + calendar-for-callback; refine later.
- Native push on iOS/Android once we leave the web phase.

---

## 10. Working Agreements for Claude
- Keep v1 scope tight; flag any drift into "Later" features before building.
- Web-first: never introduce code that only works on native and breaks the web target.
- Caller identity is sacred — always resolve it server-side from the account, never from device/phone number.
- Prefer a managed WebRTC provider over hand-rolling media infra in v1.
- When unsure about a product decision, ask rather than assume.
