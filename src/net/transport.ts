// How a RelayClient reaches the relay. The game and the e2e tests use a WebSocket to the Node
// relay (server/, deployed on its own host); unit tests can pass any transport with the same
// semantics: ordered, reliable text messages, one connection per transport.

export interface RelayTransport {
  /** True once open and until closed; send() is dropped otherwise. */
  readonly open: boolean;
  send(text: string): void;
  close(): void;
}
export interface TransportHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  /** Called once, whether the peer, the network or close() ended it. */
  onClose(): void;
}
export type ConnectTransport = (url: string, handlers: TransportHandlers) => RelayTransport;

/** The browser's (and Node 22's) WebSocket. Throws on an invalid URL. */
export const webSocketTransport: ConnectTransport = (url, handlers) => {
  const socket = new WebSocket(url);
  let closed = false;
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => handlers.onMessage(String(event.data)));
  socket.addEventListener("close", () => { if (!closed) { closed = true; handlers.onClose(); } });
  return {
    get open() { return socket.readyState === WebSocket.OPEN; },
    send: (text) => { if (socket.readyState === WebSocket.OPEN) socket.send(text); },
    close: () => socket.close(),
  };
};
