// Web Push: lets the server send a system notification ("👩 Mom is calling…")
// to a user even when their InformAlert tab is closed or in the background, as
// long as their browser is running. Subscriptions are kept in memory for the
// scaffold (they reset on restart, like the rest of the store).
//
// VAPID keys identify this server to the push services. For the demo we generate
// them at startup; set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars to keep them
// stable across restarts in production.
import webpush from "web-push";

type Sub = webpush.PushSubscription;
const subs = new Map<string, Sub[]>(); // userId -> subscriptions
let publicKey = "";

export function initPush(): string {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const keys = pub && priv ? { publicKey: pub, privateKey: priv } : webpush.generateVAPIDKeys();
  publicKey = keys.publicKey;
  webpush.setVapidDetails(
    "mailto:family@inform-alert.app",
    keys.publicKey,
    keys.privateKey
  );
  return publicKey;
}

export const getPublicKey = () => publicKey;

export function addSubscription(userId: string, sub: Sub): void {
  const list = subs.get(userId) ?? [];
  // de-dupe by endpoint
  if (!list.some((s) => s.endpoint === sub.endpoint)) list.push(sub);
  subs.set(userId, list);
}

export async function sendPush(
  userId: string,
  payload: { title: string; body: string; url?: string }
): Promise<void> {
  const list = subs.get(userId);
  if (!list || list.length === 0) return;
  const data = JSON.stringify(payload);
  await Promise.all(
    list.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, data);
      } catch (err: any) {
        // 404/410 mean the subscription is dead — drop it.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          subs.set(
            userId,
            (subs.get(userId) ?? []).filter((s) => s.endpoint !== sub.endpoint)
          );
        }
      }
    })
  );
}
