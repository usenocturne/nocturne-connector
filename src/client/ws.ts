type EventHandler = (data: any) => void;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _connected = false;
const connectionHandlers = new Set<(connected: boolean) => void>();

const topicHandlers = new Map<string, Set<EventHandler>>();
const globalHandlers = new Set<(topic: string, data: any) => void>();

function notify(callback: () => void, category: string): void {
  try {
    callback();
  } catch (error) {
    console.error(`Connector ${category} subscriber failed:`, error);
  }
}

function getWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function setConnected(connected: boolean) {
  _connected = connected;
  for (const handler of connectionHandlers) notify(() => handler(connected), "connection");
}

export function connectWebSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  socket = new WebSocket(getWsUrl());

  socket.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setConnected(true);
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "event" && msg.topic) {
        dispatch(msg.topic, msg.data);
      } else if (msg.type === "response") {
        dispatch("ws.response", msg);
      }
    } catch {
      console.warn("Ignored a malformed Connector WebSocket message");
    }
  };

  socket.onclose = () => {
    setConnected(false);
    reconnectTimer = setTimeout(connectWebSocket, 2000);
  };

  socket.onerror = () => {
    socket?.close();
  };
}

function dispatch(topic: string, data: any) {
  const handlers = topicHandlers.get(topic);
  if (handlers) {
    for (const handler of handlers) notify(() => handler(data), "event");
  }
  for (const handler of globalHandlers) notify(() => handler(topic, data), "global event");
}

export function subscribe(topic: string, handler: EventHandler): () => void {
  let handlers = topicHandlers.get(topic);
  if (!handlers) {
    handlers = new Set();
    topicHandlers.set(topic, handlers);
  }
  handlers.add(handler);
  return () => {
    handlers!.delete(handler);
    if (handlers!.size === 0) topicHandlers.delete(topic);
  };
}

export function subscribeAll(handler: (topic: string, data: any) => void): () => void {
  globalHandlers.add(handler);
  return () => globalHandlers.delete(handler);
}

export function onConnectionChange(handler: (connected: boolean) => void): () => void {
  connectionHandlers.add(handler);
  notify(() => handler(_connected), "connection");
  return () => connectionHandlers.delete(handler);
}

export function sendMessage(msg: any): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export function isConnected(): boolean {
  return _connected;
}
