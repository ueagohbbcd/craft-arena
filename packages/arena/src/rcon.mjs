import net from "node:net";
import { once } from "node:events";
const packet = (id, type, text) => {
  const body = Buffer.from(text);
  const p = Buffer.alloc(body.length + 14);
  p.writeInt32LE(body.length + 10, 0);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  body.copy(p, 12);
  return p;
};
/** Private backend RCON only. Sequential short administrative commands with response fence. */
export class RconClient {
  constructor({ host, port = 25575, password, timeoutMs = 10000 }) {
    Object.assign(this, { host, port, password, timeoutMs });
    this.next = 10;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.tail = Promise.resolve();
  }
  async connect() {
    if (!this.password) throw new Error("Operator RCON password required");
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const len = this.buffer.readInt32LE(0);
        if (len < 10 || len > 4 * 1024 * 1024) {
          this.socket.destroy(new Error("Invalid RCON packet"));
          return;
        }
        if (this.buffer.length < len + 4) break;
        const p = this.buffer.subarray(0, len + 4);
        this.buffer = this.buffer.subarray(len + 4);
        const id = p.readInt32LE(4),
          type = p.readInt32LE(8),
          text = p.toString("utf8", 12, p.length - 2);
        if (id === -1) this.fail(new Error("RCON authentication failed"));
        else this.pending.get(id)?.({ id, type, text });
      }
    });
    this.socket.on("error", (e) => this.fail(e));
    this.socket.on("close", () => this.fail(new Error("RCON closed")));
    await Promise.race([
      once(this.socket, "connect"),
      new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("RCON connect timeout")),
          this.timeoutMs,
        );
        t.unref();
      }),
    ]);
    const id = this.next++;
    await this.wait(
      id,
      (send) => {
        this.socket.write(packet(id, 3, this.password));
      },
      (p) => p.type === 2,
    );
    this.password = undefined;
    return this;
  }
  fail(error) {
    for (const handler of this.pending.values()) handler({ error });
    this.pending.clear();
  }
  wait(id, send, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("RCON response timeout"));
      }, this.timeoutMs);
      this.pending.set(id, (p) => {
        if (p.error || predicate(p)) {
          clearTimeout(timer);
          this.pending.delete(id);
          p.error ? reject(p.error) : resolve(p);
        }
      });
      send();
    });
  }
  command(text) {
    const run = async () => {
      if (!this.socket || this.socket.destroyed)
        throw new Error("RCON not connected");
      const id = this.next++,
        fence = this.next++;
      let result = "",
        fenceSent = false;
      this.pending.set(id, (p) => {
        if (p.error) return;
        result += p.text;
        if (result.length > 1024 * 1024)
          this.socket.destroy(new Error("RCON response too large"));
        // Minecraft may close when two requests arrive in one TCP read. Wait
        // for its first response before sending the fence; keep collecting all
        // response fragments until the fence acknowledgement arrives.
        if (!fenceSent && !this.socket.destroyed) {
          fenceSent = true;
          this.socket.write(packet(fence, 2, ""));
        }
      });
      try {
        await this.wait(fence, () => {
          this.socket.write(packet(id, 2, text));
        });
        return result;
      } finally {
        this.pending.delete(id);
      }
    };
    const next = this.tail.then(run);
    this.tail = next.catch(() => {});
    return next;
  }
  close() {
    this.socket?.destroy();
  }
}
