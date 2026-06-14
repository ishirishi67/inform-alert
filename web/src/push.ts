// Client-side push setup: register the service worker, ask for notification
// permission, subscribe to push, and hand the subscription to the server so it
// can later notify this user of incoming calls when the tab isn't open.
// Must be called from a user gesture (the login click) so the permission prompt
// is allowed to appear.

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function setupPush(userId: string): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.warn("[push] not supported in this browser");
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      console.warn("[push] notification permission not granted");
      return;
    }

    const { key } = await fetch("/api/push/public-key").then((r) => r.json());
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }));

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, subscription: sub }),
    });
    console.log("[push] subscribed for", userId);
  } catch (err) {
    console.warn("[push] setup failed", err);
  }
}
