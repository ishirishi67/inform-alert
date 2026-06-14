// Thin WebSocket client for presence + call signaling. Reconnects on close.
type Handler = (type: string, payload: any) => void;

export function connectWs(userId: string, onMessage: Handler) {
  let socket: WebSocket;
  let closed = false;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws?userId=${userId}`);
    socket.onmessage = (e) => {
      const { type, payload } = JSON.parse(e.data);
      onMessage(type, payload);
    };
    socket.onclose = () => {
      if (!closed) setTimeout(open, 1000);
    };
  };
  open();

  return {
    send: (type: string, payload: unknown) =>
      socket?.readyState === 1 &&
      socket.send(JSON.stringify({ type, payload })),
    close: () => {
      closed = true;
      socket?.close();
    },
  };
}
