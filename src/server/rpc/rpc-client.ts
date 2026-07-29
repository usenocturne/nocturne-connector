import { randomUUID } from "crypto";
import { encode, decode } from "./msgpack-codec";
import { createChunks, parseChunk, ChunkedMessageAssembler } from "./chunking";
import type { RPCMessage, RPCCallMessage, RPCResultMessage, RPCErrorMessage, RPCEventMessage } from "./protocol";
import { createResult, createError, createEvent } from "./protocol";
import { createLogger } from "../utils/logger";

const log = createLogger("RPCClient");

export interface RPCClientDelegate {
  onCall(id: string, method: string, params: unknown): Promise<{ result?: unknown; error?: string }>;
  onEvent(topic: string, data: unknown): void;
  onError(error: Error): void;
  onDisconnect(): void;
}

export type WireFormat = "chunked" | "base64-newline" | "raw";
type SendPriority = "normal" | "bulk";

interface RetainedChunks {
  chunks: Map<number, Buffer>;
  sentAt: number;
}

interface SendWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

const MAX_RETAINED_MESSAGES = 32;
const RETAINED_MESSAGE_TTL_MS = 2 * 60_000;

export class RPCClient {
  private socket: { write(data: Buffer | Uint8Array): void; end(): void } | null = null;
  private delegate: RPCClientDelegate | null = null;
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private inputBuffer = Buffer.alloc(0);
  private assembler = new ChunkedMessageAssembler();
  private sentChunks = new Map<string, RetainedChunks>();
  private normalSendQueue: SendWaiter[] = [];
  private bulkSendQueue: SendWaiter[] = [];
  private sendMutexLocked = false;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private connectionId: string;
  private wireFormat: WireFormat;

  constructor(connectionId: string, wireFormat: WireFormat = "chunked") {
    this.connectionId = connectionId;
    this.wireFormat = wireFormat;
    this.cleanupInterval = setInterval(() => this.periodicCleanup(), 30000);
  }

  get id(): string {
    return this.connectionId;
  }

  setSocket(socket: { write(data: Buffer | Uint8Array): void; end(): void }): void {
    this.socket = socket;
  }

  setDelegate(delegate: RPCClientDelegate): void {
    this.delegate = delegate;
  }

  async handleIncomingData(data: Buffer): Promise<void> {
    this.inputBuffer = Buffer.concat([this.inputBuffer, data]);
    await this.processInputBuffer();
  }

  private async processInputBuffer(): Promise<void> {
    if (this.wireFormat === "base64-newline") {
      await this.processBase64Lines();
    } else {
      await this.processChunked();
    }
  }

  private async processBase64Lines(): Promise<void> {
    while (true) {
      const newlineIdx = this.inputBuffer.indexOf(0x0a);
      if (newlineIdx === -1) break;

      const line = this.inputBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
      this.inputBuffer = this.inputBuffer.subarray(newlineIdx + 1);

      if (!line) continue;

      let decoded: Buffer;
      try {
        decoded = Buffer.from(line, "base64");
      } catch {
        log.warn(`Invalid base64 line (${line.length} chars)`);
        continue;
      }

      try {
        const msg = decode(decoded);
        await this.handleMessage(msg);
        continue;
      } catch {
      }

      const result = parseChunk(decoded);
      if (result.status === "success") {
        if (result.envelope.total === 1) {
          try {
            const msg = decode(result.payload);
            await this.handleMessage(msg);
          } catch (err) {
            log.error(`Failed to decode chunk payload: ${err}`);
          }
        } else {
          const assembled = this.assembler.addChunk(
            result.envelope.messageId,
            result.envelope.index,
            result.envelope.total,
            result.payload
          );
          if (assembled) {
            try {
              const msg = decode(assembled);
              await this.handleMessage(msg);
            } catch (err) {
              log.error(`Failed to decode assembled message: ${err}`);
            }
          }
        }
      } else {
        log.warn(`Failed to parse base64 line (${decoded.length} bytes): not MsgPack or chunk`);
      }
    }
  }

  private async processChunked(): Promise<void> {
    while (this.inputBuffer.length > 0) {
      try {
        const msg = decode(this.inputBuffer);
        this.inputBuffer = Buffer.alloc(0);
        await this.handleMessage(msg);
        continue;
      } catch {
      }

      const result = parseChunk(this.inputBuffer);

      if (result.status === "needMoreData") break;

      if (result.status === "invalid") {
        const drop = Math.min(Math.max(result.dropBytes, 1), this.inputBuffer.length);
        this.inputBuffer = this.inputBuffer.subarray(drop);
        log.warn(`Discarding invalid chunk (dropped ${drop} bytes): ${result.reason}`);
        continue;
      }

      this.inputBuffer = this.inputBuffer.subarray(result.consumed);

      if (result.envelope.total === 1) {
        try {
          const msg = decode(result.payload);
          await this.handleMessage(msg);
        } catch (err) {
          log.error(`Failed to decode message: ${err}`);
        }
      } else {
        const assembled = this.assembler.addChunk(
          result.envelope.messageId,
          result.envelope.index,
          result.envelope.total,
          result.payload
        );
        if (assembled) {
          try {
            const msg = decode(assembled);
            await this.handleMessage(msg);
          } catch (err) {
            log.error(`Failed to decode assembled message: ${err}`);
          }
        }
      }
    }
  }

  private async handleMessage(msg: RPCMessage): Promise<void> {
    switch (msg.type) {
      case "result": {
        const m = msg as RPCResultMessage;
        const pending = this.pendingRequests.get(m.id);
        if (pending) {
          this.pendingRequests.delete(m.id);
          clearTimeout(pending.timeout);
          pending.resolve(m.result);
        }
        break;
      }
      case "error": {
        const m = msg as RPCErrorMessage;
        const pending = this.pendingRequests.get(m.id);
        if (pending) {
          this.pendingRequests.delete(m.id);
          clearTimeout(pending.timeout);
          pending.reject(new Error(m.error));
        }
        break;
      }
      case "event": {
        const m = msg as RPCEventMessage;
        this.delegate?.onEvent(m.topic, m.data);
        break;
      }
      case "call": {
        const m = msg as RPCCallMessage;
        if (this.delegate) {
          const response = await this.delegate.onCall(m.id, m.method, m.params);
          if (response.error) {
            await this.sendMessage(
              createError(m.id, response.error),
              priorityForResponseTo(m.method),
            );
          } else {
            await this.sendMessage(
              createResult(m.id, response.result),
              priorityForResponseTo(m.method),
            );
          }
        } else {
          await this.sendMessage(createError(m.id, "No handler available"));
        }
        break;
      }
    }
  }

  async call(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    const id = randomUUID();
    const msg: RPCCallMessage = { type: "call", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC call timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.sendMessage(msg, priorityForMethod(method)).catch((err) => {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async sendEvent(topic: string, data: unknown): Promise<void> {
    await this.sendMessage(createEvent(topic, data), priorityForTopic(topic));
  }

  private async sendMessage(
    msg: RPCMessage,
    priority: SendPriority = "normal",
  ): Promise<void> {
    const messageId = "id" in msg ? msg.id : randomUUID();
    const encoded = encode(msg);
    if (this.wireFormat === "base64-newline") {
      await this.sendFramed(encoded, messageId, priority, true);
    } else if (this.wireFormat === "raw") {
      await this.acquireMutex(priority);
      try {
        this.writeToSocket(encoded);
      } finally {
        this.releaseMutex();
      }
    } else {
      await this.sendFramed(encoded, messageId, priority, false);
    }
  }

  private async sendFramed(
    data: Buffer,
    messageId: string,
    priority: SendPriority,
    base64Newline: boolean,
  ): Promise<void> {
    const chunks = createChunks(data, messageId);
    this.retainChunks(messageId, chunks);
    const writeChunk = (chunk: Buffer) => {
      this.writeToSocket(
        base64Newline
          ? Buffer.from(`${chunk.toString("base64")}\n`)
          : chunk,
      );
    };

    if (priority === "normal") {
      await this.acquireMutex("normal");
      try {
        for (const chunk of chunks) writeChunk(chunk);
      } finally {
        this.releaseMutex();
      }
      return;
    }

    for (let i = 0; i < chunks.length; i++) {
      await this.acquireMutex("bulk");
      try {
        const chunk = chunks[i];
        if (chunk) writeChunk(chunk);
      } finally {
        this.releaseMutex();
      }
    }
  }

  private retainChunks(messageId: string, chunks: Buffer[]): void {
    const chunkMap = new Map<number, Buffer>();
    chunks.forEach((chunk, index) => chunkMap.set(index, chunk));
    this.sentChunks.delete(messageId);
    this.sentChunks.set(messageId, { chunks: chunkMap, sentAt: Date.now() });
    while (this.sentChunks.size > MAX_RETAINED_MESSAGES) {
      const oldest = this.sentChunks.keys().next().value;
      if (typeof oldest !== "string") break;
      this.sentChunks.delete(oldest);
    }
  }

  async retransmitChunk(messageId: string, chunkIndex: number): Promise<void> {
    const retained = this.sentChunks.get(messageId);
    const chunk = retained?.chunks.get(chunkIndex);
    if (!chunk) {
      log.error(`Cannot retransmit chunk ${chunkIndex} for ${messageId}: not found`);
      return;
    }
    log.warn(`Retransmitting chunk ${chunkIndex + 1} for ${messageId}`);
    await this.acquireMutex("normal");
    try {
      this.writeToSocket(
        this.wireFormat === "base64-newline"
          ? Buffer.from(`${chunk.toString("base64")}\n`)
          : chunk,
      );
    } finally {
      this.releaseMutex();
    }
  }

  private writeToSocket(data: Buffer): void {
    if (!this.socket) {
      throw new Error("Write attempted on closed connection");
    }
    this.socket.write(data);
  }

  private async acquireMutex(priority: SendPriority): Promise<void> {
    if (!this.sendMutexLocked) {
      this.sendMutexLocked = true;
      return;
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (priority === "normal") {
        this.normalSendQueue.push(waiter);
      } else {
        this.bulkSendQueue.push(waiter);
      }
    });
  }

  private releaseMutex(): void {
    const next = this.normalSendQueue.shift() ?? this.bulkSendQueue.shift();
    if (next) {
      next.resolve();
    } else {
      this.sendMutexLocked = false;
    }
  }

  private periodicCleanup(): void {
    const cutoff = Date.now() - RETAINED_MESSAGE_TTL_MS;
    for (const [messageId, retained] of this.sentChunks) {
      if (retained.sentAt < cutoff) this.sentChunks.delete(messageId);
    }
    if (this.assembler.pendingCount > 5) {
      this.assembler.clear();
      log.warn("Cleared stale pending chunks");
    }
  }

  cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();
    this.inputBuffer = Buffer.alloc(0);
    this.assembler.clear();
    this.sentChunks.clear();
    for (const waiter of [...this.normalSendQueue, ...this.bulkSendQueue]) {
      waiter.reject(new Error("Connection closed"));
    }
    this.normalSendQueue.length = 0;
    this.bulkSendQueue.length = 0;
    this.sendMutexLocked = false;
    this.socket = null;
  }
}

function priorityForMethod(method: string): SendPriority {
  return isBulkMethod(method) ? "bulk" : "normal";
}

function priorityForResponseTo(method: string): SendPriority {
  return method === "device.ota.transfer" || method === "ota.transfer"
    ? "bulk"
    : "normal";
}

function priorityForTopic(topic: string): SendPriority {
  return isBulkMethod(topic) ? "bulk" : "normal";
}

function isBulkMethod(value: string): boolean {
  return value === "ota.chunk" ||
    value === "system.ota.chunk" ||
    value === "ota.asset_range_chunk" ||
    value === "system.ota.asset_range_chunk";
}
