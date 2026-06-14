/* InformAlert service worker — receives push notifications and shows the
   "X is calling…" system notification even when the app tab is closed. */

self.addEventListener("push", (event) => {
  let data = { title: "Incoming call", body: "", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_e) {
    /* ignore malformed payloads */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: "inform-alert-call", // collapse repeats into one
      renotify: true,
      requireInteraction: true, // stay until the user acts
      vibrate: [500, 300, 500, 300, 500],
      data: { url: data.url || "/" },
    })
  );
});

// Tapping the notification focuses the app (or opens it if closed).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          if ("focus" in client) return client.focus();
        }
        if (self.clients.openWindow)
          return self.clients.openWindow(event.notification.data.url || "/");
      })
  );
});
