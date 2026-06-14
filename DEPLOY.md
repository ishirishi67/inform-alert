# Deploying InformAlert to Render

The app is packaged as **one always-on Node service** that serves the API, the
WebSocket signaling hub, and the built web UI from a single URL. Config lives in
[`render.yaml`](./render.yaml). Render deploys from a Git repo, so the flow is:
**push to GitHub → connect on Render**.

## Step 1 — Create an empty GitHub repo
1. Go to https://github.com/new
2. Name it `inform-alert`. **Leave it empty** (no README, no .gitignore — we already have those).
3. Click **Create repository**.

## Step 2 — Push this code (run in the project folder)
Replace `<YOUR_USERNAME>` with your GitHub username:

```bash
git remote add origin https://github.com/<YOUR_USERNAME>/inform-alert.git
git push -u origin main
```

(If GitHub asks you to sign in, use a Personal Access Token as the password:
github.com → Settings → Developer settings → Personal access tokens.)

## Step 3 — Deploy on Render
1. Sign up / log in at https://dashboard.render.com (you can sign in with GitHub).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub account and pick the `inform-alert` repo.
4. Render reads `render.yaml` and proposes a free web service. Click **Apply**.
5. Wait for the build (`npm install && npm run build`) and start (`npm start`).
6. Open the URL Render gives you (e.g. `https://inform-alert.onrender.com`).

## Step 4 — Try it live
Open the URL in two tabs / two phones, log in as **Ishi** and **Dad**, and call.
The free tier sleeps after ~15 min idle and takes ~30s to wake on the next visit;
the client auto-reconnects.

## Updating later
Every `git push` to `main` triggers an automatic redeploy.

---

### Important caveats (this is a demo build)
- **Data is in-memory** — messages/calls reset on every restart/redeploy. Add
  PostgreSQL (Render offers a managed one) to persist.
- **Stub login** — anyone can pick any family member. Add real auth (Google
  Sign-In) before sharing beyond testing.
- **No real audio/video yet** — calls show the right caller but the media stream
  is stubbed. Wire a managed WebRTC provider (LiveKit/Twilio/Daily) for real calls.
See [CLAUDE.md](./CLAUDE.md) §6 for the production roadmap.
