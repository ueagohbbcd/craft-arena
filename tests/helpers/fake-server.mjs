/** Test doubles for a Minecraft server that speaks protocol v1 over RCON. */

export const storageReply = (id, snbt) =>
  `Storage ${id} has the following contents: ${snbt}`;

/**
 * A fake server. Set `session` / `config` (SNBT, or null for a failed read),
 * `players` (a Set; answers `list`) and exact `replies`. `commands` records
 * every command plus "rcon-close"; `rcon` is an RconClient factory. A
 * `data merge` into arena:config replaces `config` unless `replies` has it.
 */
export function fakeServer({ commands = [] } = {}) {
  const s = {
    commands,
    session: '{version:1,state:"waiting",winner:""}',
    config: "{}",
    players: new Set(),
    replies: {},
  };
  s.rcon = () => ({
    connected: false,
    closed: false,
    async connect() {
      this.connected = true;
    },
    close() {
      this.closed = true;
      commands.push("rcon-close");
    },
    async command(c) {
      commands.push(c);
      if (c in s.replies) return s.replies[c];
      if (c === "data get storage arena:session")
        return s.session === null
          ? "Connection reset"
          : storageReply("arena:session", s.session);
      if (c === "data get storage arena:config")
        return storageReply("arena:config", s.config);
      if (c === "data remove storage arena:config durationMs")
        return "Found no elements matching durationMs";
      if (c.startsWith("data merge storage arena:config ")) {
        // Remove-then-merge replaces the whole compound in practice.
        s.config = c.slice("data merge storage arena:config ".length);
        return "Modified storage arena:config";
      }
      if (c.startsWith("function #arena:"))
        // Real 1.21.1 reply for a one-function tag.
        return `Running function example:${c.slice(16)}`;
      if (c === "list")
        return `There are ${s.players.size} of a max of 20 players online: ${[...s.players].join(", ")}`;
      return "OK";
    },
  });
  return s;
}
