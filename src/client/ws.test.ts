import { afterEach, expect, test } from "bun:test";

const originalSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (originalSocket) Object.defineProperty(globalThis, "WebSocket", originalSocket);
  else Reflect.deleteProperty(globalThis, "WebSocket");
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
});

test("a failing event subscriber cannot prevent later subscribers receiving the message", async () => {
  const observed: { socket?: TestSocket } = {};
  class TestSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    onmessage?: (event: { data: string }) => void;
    constructor() { observed.socket = this; }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestSocket });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", host: "localhost" } });
  const { connectWebSocket, subscribe, subscribeAll } = await import("./ws");
  const values: unknown[] = [];
  cleanups.push(subscribe("fixture", () => { throw new Error("Broken subscriber"); }));
  cleanups.push(subscribe("fixture", (value) => values.push(value)));
  cleanups.push(subscribeAll((topic, value) => values.push({ topic, value })));
  connectWebSocket();
  const activeSocket = observed.socket;
  cleanups.push(() => { if (observed.socket) observed.socket.readyState = 3; });
  expect(activeSocket).toBeDefined();
  activeSocket?.onmessage?.({ data: JSON.stringify({ type: "event", topic: "fixture", data: 42 }) });
  expect(values).toEqual([42, { topic: "fixture", value: 42 }]);
});
