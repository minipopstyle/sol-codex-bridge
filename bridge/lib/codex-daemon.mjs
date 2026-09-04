import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function daemonSocketPath() {
  return path.join(codexHome(), "app-server-control", "app-server-control.sock");
}

export function daemonSocketExists() {
  try {
    return fs.statSync(daemonSocketPath()).isSocket();
  } catch {
    return false;
  }
}

function encodeClientFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function tryDecodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const fin = Boolean(b0 & 0x80);
  const opcode = b0 & 0x0f;
  const masked = Boolean(b1 & 0x80);
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
    len = Number(big);
    offset = 10;
  }
  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + len) return null;
  let payload = Buffer.from(buffer.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return {
    frame: { fin, opcode, payload },
    rest: buffer.subarray(offset + len)
  };
}

class UnixWebSocketRpc {
  constructor(socketPath, timeoutMs = 8000) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.handshakeKey = null;
    this.waiters = new Map();
    this.fragmentOpcode = null;
    this.fragmentParts = [];
    this.failed = null;
  }

  async connect() {
    if (!daemonSocketExists()) throw new Error(`Codex app-server daemon socket 不存在：${this.socketPath}`);
    this.socket = net.createConnection({ path: this.socketPath });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (error) => this.failAll(error));
    this.socket.on("close", () => this.failAll(new Error("Codex app-server daemon 已断开")));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 Codex app-server daemon 超时")), this.timeoutMs);
      const onError = (error) => { clearTimeout(timer); reject(error); };
      this.socket.once("connect", () => { clearTimeout(timer); this.socket.off("error", onError); resolve(); });
      this.socket.once("error", onError);
    });

    this.handshakeKey = crypto.randomBytes(16).toString("base64");
    const request = [
      "GET / HTTP/1.1",
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${this.handshakeKey}`,
      "Sec-WebSocket-Version: 13",
      "\r\n"
    ].join("\r\n");
    this.socket.write(request);

    await this.waitForHandshake();
  }

  waitForHandshake() {
    if (this.handshakeDone) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex daemon WebSocket 握手超时")), this.timeoutMs);
      this.handshakeResolve = () => { clearTimeout(timer); resolve(); };
      this.handshakeReject = (error) => { clearTimeout(timer); reject(error); };
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeDone) {
      const marker = this.buffer.indexOf("\r\n\r\n");
      if (marker < 0) return;
      const header = this.buffer.subarray(0, marker + 4).toString("utf8");
      this.buffer = this.buffer.subarray(marker + 4);
      const status = header.split("\r\n", 1)[0] || "";
      if (!/\s101\s/.test(status)) {
        const error = new Error(`Codex daemon WebSocket 握手失败：${status || "invalid response"}`);
        this.handshakeReject?.(error);
        this.failAll(error);
        return;
      }
      const expected = crypto.createHash("sha1")
        .update(`${this.handshakeKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      const acceptLine = header.split("\r\n").find((line) => /^Sec-WebSocket-Accept:/i.test(line));
      const actual = acceptLine?.split(":").slice(1).join(":").trim();
      if (actual && actual !== expected) {
        const error = new Error("Codex daemon WebSocket 握手校验失败");
        this.handshakeReject?.(error);
        this.failAll(error);
        return;
      }
      this.handshakeDone = true;
      this.handshakeResolve?.();
    }
    this.processFrames();
  }

  processFrames() {
    while (this.buffer.length) {
      const decoded = tryDecodeFrame(this.buffer);
      if (!decoded) return;
      this.buffer = decoded.rest;
      const { fin, opcode, payload } = decoded.frame;

      if (opcode === 0x8) {
        this.failAll(new Error("Codex daemon 关闭了 WebSocket"));
        return;
      }
      if (opcode === 0x9) {
        this.socket?.write(encodeClientFrame(payload, 0xA));
        continue;
      }
      if (opcode === 0xA) continue;

      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          if (opcode === 0x1) this.handleText(payload.toString("utf8"));
        } else {
          this.fragmentOpcode = opcode;
          this.fragmentParts = [payload];
        }
        continue;
      }
      if (opcode === 0x0 && this.fragmentOpcode != null) {
        this.fragmentParts.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragmentParts);
          if (this.fragmentOpcode === 0x1) this.handleText(full.toString("utf8"));
          this.fragmentOpcode = null;
          this.fragmentParts = [];
        }
      }
    }
  }

  handleText(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const key = String(message.id);
      const waiter = this.waiters.get(key);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.waiters.delete(key);
        if (message.error) {
          const error = new Error(message.error.message || `Codex JSON-RPC error ${message.error.code}`);
          error.code = message.error.code;
          error.rpcMethod = waiter.method;
          waiter.reject(error);
        } else {
          waiter.resolve(message.result);
        }
      }
    }
  }

  sendJson(value) {
    if (!this.socket || !this.handshakeDone) throw new Error("Codex daemon WebSocket 尚未连接");
    this.socket.write(encodeClientFrame(JSON.stringify(value)));
  }

  request(id, method, params) {
    const key = String(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`Codex JSON-RPC 请求超时：${method}`));
      }, this.timeoutMs);
      this.waiters.set(key, { resolve, reject, timer, method });
      this.sendJson({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.sendJson({ method, params });
  }

  failAll(error) {
    if (this.failed) return;
    this.failed = error;
    this.handshakeReject?.(error);
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  close() {
    try { this.socket?.write(encodeClientFrame("", 0x8)); } catch {}
    try { this.socket?.end(); } catch {}
  }
}

export async function queueViaLocalDaemon(sessionId, prompt) {
  const socketPath = daemonSocketPath();
  const rpc = new UnixWebSocketRpc(socketPath, 10_000);
  try {
    await rpc.connect();
    await rpc.request(1, "initialize", {
      clientInfo: {
        name: "sol_codex_bridge",
        title: "Sol Codex Local Bridge",
        version: "0.2.11"
      },
      capabilities: { experimentalApi: true }
    });
    rpc.notify("initialized", {});
    const clientUserMessageId = crypto.randomUUID();
    const result = await rpc.request(2, "thread/queue/add", {
      threadId: sessionId,
      input: [{ type: "text", text: prompt }],
      clientUserMessageId
    });
    return {
      ok: true,
      transport: "app-server-daemon",
      queuedSubmissionId: result?.queuedSubmission?.id || null,
      clientUserMessageId
    };
  } finally {
    rpc.close();
  }
}
