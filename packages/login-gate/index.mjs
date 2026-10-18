/**
 * Trusted login gate in front of the Minecraft server (offline mode). One gate
 * serves one participant: it lets a connection through only when its Login
 * Start names one of that participant's characters, at most one connection
 * per character, and then forwards the bytes unchanged in both directions.
 * Status pings pass through; transfers and legacy pings are refused.
 *
 * The participant's network reaches only its gate, never the server, so a
 * container cannot log in as another participant's character. The gate keeps
 * no game state and never rewrites game packets.
 */
import net from "node:net";

const MAX_HEADER_BYTES = 4096;

/** Reads a VarInt at `offset`; returns { value, size } or null when incomplete. */
export function readVarInt(buffer, offset = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return null;
    const byte = buffer[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return { value: value | 0, size: i + 1 };
  }
  throw new Error("VarInt too long");
}

export function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    bytes.push(byte);
  } while (v);
  return Buffer.from(bytes);
}

/** One length-prefixed packet at `offset`: { id, body, end } or null when incomplete. */
export function readPacket(buffer, offset = 0) {
  const length = readVarInt(buffer, offset);
  if (!length) return null;
  if (length.value < 1 || length.value > MAX_HEADER_BYTES)
    throw new Error("Bad packet length");
  const start = offset + length.size,
    end = start + length.value;
  if (end > buffer.length) return null;
  const id = readVarInt(buffer, start);
  return { id: id.value, body: buffer.subarray(start + id.size, end), end };
}

function readString(body, offset) {
  const length = readVarInt(body, offset);
  if (!length || length.value > 1024) throw new Error("Bad string");
  const start = offset + length.size,
    end = start + length.value;
  if (end > body.length) throw new Error("Bad string");
  return { value: body.subarray(start, end).toString("utf8"), end };
}

export function parseHandshake(body) {
  let at = 0;
  const protocol = readVarInt(body, at);
  at += protocol.size;
  const address = readString(body, at);
  at = address.end + 2;
  const nextState = readVarInt(body, at);
  if (!nextState) throw new Error("Bad handshake");
  return { protocol: protocol.value, nextState: nextState.value };
}

/** A login-state Disconnect packet with a plain text reason (JSON text component). */
export function disconnectPacket(reason) {
  const text = Buffer.from(JSON.stringify({ text: reason }), "utf8");
  const payload = Buffer.concat([
    writeVarInt(0x00),
    writeVarInt(text.length),
    text,
  ]);
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

/**
 * Start a gate. `usernames` are the characters this participant may use
 * (compared case-insensitively, as the server does). Returns
 * { port, close(), connections() }.
 */
export async function startLoginGate({
  host = "0.0.0.0",
  port = 25565,
  upstream,
  usernames,
  headerTimeoutMs = 5000,
  log = (line) => console.error(line),
  connect = (options) => net.connect(options),
}) {
  if (!upstream?.host) throw new Error("upstream.host is required");
  const allowed = new Map(
    (usernames ?? []).map((name) => [String(name).toLowerCase(), name]),
  );
  if (!allowed.size) throw new Error("usernames must not be empty");
  const online = new Map(); // lowercase name → client socket
  const sockets = new Set();

  const forward = (client, buffered, name) => {
    const server = connect({
      host: upstream.host,
      port: upstream.port ?? 25565,
    });
    sockets.add(server);
    const done = () => {
      client.destroy();
      server.destroy();
      if (name && online.get(name) === client) online.delete(name);
      sockets.delete(server);
    };
    server.on("error", done).on("close", done);
    client.on("error", done).on("close", done);
    server.write(buffered);
    client.pipe(server);
    server.pipe(client);
    client.resume();
  };

  const refuse = (client, reason, login) => {
    log(`login-gate: refused ${client.remoteAddress ?? "?"}: ${reason}`);
    if (login) client.end(disconnectPacket(reason));
    else client.destroy();
  };

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => {});
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(
      () => refuse(client, "No login in time", false),
      headerTimeoutMs,
    );
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (buffer[0] === 0xfe)
          return finish(() => refuse(client, "Legacy ping", false));
        const handshake = readPacket(buffer);
        if (!handshake) return check();
        if (handshake.id !== 0x00) throw new Error("Expected a handshake");
        const { nextState } = parseHandshake(handshake.body);
        if (nextState === 1) return finish(() => forward(client, buffer));
        if (nextState !== 2)
          return finish(() =>
            refuse(client, "Transfers are not accepted", true),
          );
        const login = readPacket(buffer, handshake.end);
        if (!login) return check();
        if (login.id !== 0x00) throw new Error("Expected Login Start");
        const name = readString(login.body, 0).value;
        const key = name.toLowerCase();
        if (!allowed.has(key))
          return finish(() =>
            refuse(
              client,
              `${name} is not a character of this participant`,
              true,
            ),
          );
        if (online.has(key))
          return finish(() =>
            refuse(client, `${name} is already connected`, true),
          );
        online.set(key, client);
        log(`login-gate: ${name} admitted`);
        finish(() => forward(client, buffer, key));
      } catch (error) {
        finish(() => refuse(client, error.message, false));
      }
    };
    const check = () => {
      if (buffer.length > MAX_HEADER_BYTES)
        finish(() => refuse(client, "Login header too large", false));
    };
    const finish = (next) => {
      clearTimeout(timer);
      client.off("data", onData);
      client.pause();
      next();
    };
    client.on("data", onData);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    connections: () => [...online.keys()].map((key) => allowed.get(key)),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
