import { decode, encode } from "@msgpack/msgpack";
import { createConnection, type Socket } from "node:net";
import { createLogger } from "../utils/logger";
import type {
  HostBridgeEvent,
  HostBridgeRequest,
  HostBridgeResponse,
} from "./bridge-types";

const log = createLogger("HostBridge");
const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HostBridgeCallOptions {
  timeoutMs?: number;
  priority?: boolean;
}

export interface HostBridgeClient {
  call<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: HostBridgeCallOptions,
  ): Promise<TResult>;
  onEvent<T = unknown>(topic: string, listener: (data: T) => void): () => void;
  resetConnection?(): void;
  close(): void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class HostBridgeError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HostBridgeError";
  }
}

export class HostBridge implements HostBridgeClient {
  private socket: Socket | null = null;
  private connectPromise: Promise<Socket> | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;
  private connectionGeneration = 0;

  constructor(
    private readonly pipePath: string,
    private readonly token: string,
  ) {
    if (!pipePath) throw new Error("Host bridge pipe path is required");
    if (!token) throw new Error("Host bridge token is required");
  }

  async call<TResult = unknown>(
    method: string,
    params: unknown = {},
    options: HostBridgeCallOptions = {},
  ): Promise<TResult> {
    if (!method) throw new Error("Host bridge method is required");
    if (options.priority) {
      return this.callDedicated<TResult>(
        method,
        params,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    }
    const socket = await this.ensureConnected();
    const id = this.allocateRequestId();
    const key = String(id);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const request: HostBridgeRequest = {
      type: "request",
      id,
      token: this.token,
      generation: this.connectionGeneration,
      method,
      params,
    };

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new HostBridgeError(`Host request ${method} timed out after ${timeoutMs}ms`, "timeout"));
      }, timeoutMs);
      this.pending.set(key, {
        method,
        resolve: (value) => resolve(value as TResult),
        reject,
        timeout,
      });

      this.enqueueWrite(socket, frame(request)).catch((error) => {
        const pending = this.pending.get(key);
        if (!pending) return;
        this.pending.delete(key);
        clearTimeout(pending.timeout);
        pending.reject(asError(error, `Host request ${method} write failed`));
      });
    });
  }

  onEvent<T = unknown>(topic: string, listener: (data: T) => void): () => void {
    const listeners = this.listeners.get(topic) ?? new Set<(data: unknown) => void>();
    const wrapped = (data: unknown) => listener(data as T);
    listeners.add(wrapped);
    this.listeners.set(topic, listeners);
    return () => {
      listeners.delete(wrapped);
      if (listeners.size === 0) this.listeners.delete(topic);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    this.receiveBuffer = Buffer.alloc(0);
    if (socket && !socket.destroyed) socket.destroy();
    this.rejectPending(new HostBridgeError("Host bridge closed", "closed"));
  }

  resetConnection(): void {
    if (this.closed) return;
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    this.receiveBuffer = Buffer.alloc(0);
    this.writeTail = Promise.resolve();
    if (socket && !socket.destroyed) socket.destroy();
    this.rejectPending(new HostBridgeError("Host bridge connection reset", "reset"));
  }

  private ensureConnected(): Promise<Socket> {
    if (this.closed) {
      return Promise.reject(new HostBridgeError("Host bridge is closed", "closed"));
    }
    if (
      this.socket &&
      !this.socket.destroyed &&
      this.socket.readyState === "open"
    ) {
      return Promise.resolve(this.socket);
    }
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.pipePath);
      this.socket = socket;

      const onInitialError = (error: Error) => {
        socket.off("connect", onConnect);
        if (this.socket === socket) this.socket = null;
        socket.destroy();
        reject(new HostBridgeError(`Unable to connect to native host: ${error.message}`, "connect"));
      };
      const onConnect = () => {
        socket.off("error", onInitialError);
        this.connectionGeneration =
          this.connectionGeneration >= Number.MAX_SAFE_INTEGER
            ? 1
            : this.connectionGeneration + 1;
        log.info(`Connected to native host pipe ${this.pipePath}`);
        resolve(socket);
      };

      socket.once("connect", onConnect);
      socket.once("error", onInitialError);
      socket.on("error", (error) => {
        log.warn(`Native host pipe error: ${error.message}`);
      });
      socket.on("data", (data) =>
        this.consume(typeof data === "string" ? Buffer.from(data) : data),
      );
      socket.on("close", () => this.handleDisconnect(socket));
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private enqueueWrite(socket: Socket, data: Buffer): Promise<void> {
    const write = this.writeTail
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (this.socket !== socket || socket.destroyed) {
              reject(new HostBridgeError("Native host connection changed before write", "disconnected"));
              return;
            }
            socket.write(data, (error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
      );
    this.writeTail = write;
    return write;
  }

  private callDedicated<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<TResult> {
    const id = this.allocateRequestId();
    const request: HostBridgeRequest = {
      type: "request",
      id,
      token: this.token,
      generation: 1,
      method,
      params,
    };
    return new Promise<TResult>((resolve, reject) => {
      const socket = createConnection(this.pipePath);
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(result as TResult);
      };
      const timeout = setTimeout(
        () => finish(new HostBridgeError(`Host request ${method} timed out after ${timeoutMs}ms`, "timeout")),
        timeoutMs,
      );
      socket.on("connect", () => {
        socket.write(frame(request), (error) => {
          if (error) finish(asError(error, `Host request ${method} write failed`));
        });
      });
      socket.on("data", (data) => {
        const chunk = typeof data === "string" ? Buffer.from(data) : data;
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= HEADER_BYTES) {
          const length = buffer.readUInt32LE(0);
          if (length === 0 || length > MAX_FRAME_BYTES) {
            finish(new HostBridgeError(`Native host frame length ${length} is invalid`, "protocol"));
            return;
          }
          if (buffer.length < HEADER_BYTES + length) return;
          const payload = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
          buffer = buffer.subarray(HEADER_BYTES + length);
          let message: unknown;
          try {
            message = decode(payload);
          } catch (error) {
            finish(new HostBridgeError(`Native host sent invalid MessagePack: ${asError(error).message}`, "protocol"));
            return;
          }
          const value = asRecord(message);
          if (value?.type !== "response" || requestKey(value.id) !== String(id)) continue;
          const response = value as unknown as HostBridgeResponse;
          const error = hostError(response.error);
          finish(error ?? undefined, response.result);
          return;
        }
      });
      socket.on("error", (error) => {
        finish(new HostBridgeError(`Unable to use native control pipe: ${error.message}`, "connect"));
      });
      socket.on("close", () => {
        if (!settled) finish(new HostBridgeError("Native control pipe disconnected", "disconnected"));
      });
    });
  }

  private consume(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

    while (this.receiveBuffer.length >= HEADER_BYTES) {
      const length = this.receiveBuffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.failProtocol(`Native host frame length ${length} is invalid`);
        return;
      }
      if (this.receiveBuffer.length < HEADER_BYTES + length) return;

      const payload = this.receiveBuffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.receiveBuffer = this.receiveBuffer.subarray(HEADER_BYTES + length);
      let message: unknown;
      try {
        message = decode(payload);
      } catch (error) {
        this.failProtocol(`Native host sent invalid MessagePack: ${asError(error).message}`);
        return;
      }
      this.dispatch(message);
    }

    if (this.receiveBuffer.length > MAX_FRAME_BYTES + HEADER_BYTES) {
      this.failProtocol("Native host receive buffer exceeded the frame limit");
    }
  }

  private dispatch(message: unknown): void {
    const value = asRecord(message);
    if (!value || typeof value.type !== "string") {
      this.failProtocol("Native host envelope is not an object with a type");
      return;
    }

    if (value.type === "response") {
      if (
        value.generation !== undefined &&
        value.generation !== this.connectionGeneration
      ) {
        return;
      }
      const response = value as unknown as HostBridgeResponse;
      const key = requestKey(response.id);
      if (!key) {
        this.failProtocol("Native host response is missing an ID");
        return;
      }
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timeout);

      const error = hostError(response.error);
      if (error) pending.reject(error);
      else pending.resolve(response.result);
      return;
    }

    if (value.type === "event") {
      if (
        value.generation !== undefined &&
        value.generation !== this.connectionGeneration
      ) {
        return;
      }
      const event = value as unknown as HostBridgeEvent;
      if (typeof event.topic !== "string") {
        this.failProtocol("Native host event is missing a topic");
        return;
      }
      for (const listener of this.listeners.get(event.topic) ?? []) {
        try {
          listener(event.data);
        } catch (error) {
          log.error(`Host event listener for ${event.topic} failed: ${asError(error).message}`);
        }
      }
      return;
    }

    this.failProtocol(`Native host sent unsupported envelope type ${value.type}`);
  }

  private handleDisconnect(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.receiveBuffer = Buffer.alloc(0);
    this.writeTail = Promise.resolve();
    this.rejectPending(new HostBridgeError("Native host disconnected", "disconnected"));
    if (!this.closed) log.warn("Native host pipe disconnected");
  }

  private failProtocol(message: string): void {
    log.error(message);
    const socket = this.socket;
    if (socket && !socket.destroyed) socket.destroy(new HostBridgeError(message, "protocol"));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private allocateRequestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
    return id;
  }
}

export function frame(value: unknown): Buffer {
  const payload = Buffer.from(encode(value));
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw new HostBridgeError(`Host bridge frame size ${payload.length} is invalid`, "frame_size");
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requestKey(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  return null;
}

function hostError(value: unknown): HostBridgeError | null {
  if (typeof value === "string" && value) return new HostBridgeError(value);
  const record = asRecord(value);
  if (!record) return null;
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.error === "string"
        ? record.error
        : "Native host request failed";
  const code = typeof record.code === "string" ? record.code : undefined;
  return new HostBridgeError(message, code);
}

function asError(value: unknown, fallback = "Native host bridge failed"): Error {
  return value instanceof Error ? value : new Error(value == null ? fallback : String(value));
}
