/**
 * Minimal SNBT (stringified NBT) reader and writer for the server protocol.
 * Numbers become JS numbers whatever their suffix, booleans become bytes
 * (1/0) and typed arrays ([B;...], [I;...], [L;...]) become plain arrays.
 */
const BARE = /^[A-Za-z0-9._+-]+$/;
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?([bslfd])?$/i;

export function parseSnbt(text) {
  const { value, end } = parseSnbtPrefix(text);
  if (end !== text.length)
    throw new SyntaxError(`SNBT trailing data at ${end}`);
  return value;
}

/** Reads one SNBT value from the start of `text`; `end` is where it stopped. */
export function parseSnbtPrefix(text) {
  if (typeof text !== "string") throw new TypeError("SNBT text required");
  let i = 0;
  const fail = (message) => {
    throw new SyntaxError(`SNBT ${message} at ${i}`);
  };
  const space = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const expect = (ch) => {
    space();
    if (text[i] !== ch) fail(`expected '${ch}'`);
    i++;
  };
  const quoted = () => {
    const q = text[i++];
    let out = "";
    while (i < text.length && text[i] !== q) {
      if (text[i] === "\\") {
        const next = text[++i];
        if (next === undefined) fail("unterminated escape");
        out +=
          { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", s: " " }[next] ?? next;
        i++;
      } else out += text[i++];
    }
    if (text[i] !== q) fail("unterminated string");
    i++;
    return out;
  };
  const bare = () => {
    const start = i;
    while (i < text.length && /[A-Za-z0-9._+-]/.test(text[i])) i++;
    if (i === start) fail("expected value");
    return text.slice(start, i);
  };
  const scalar = (word) => {
    if (word === "true") return 1;
    if (word === "false") return 0;
    const m = NUMBER.exec(word);
    if (!m) return word;
    const value = Number(word.slice(0, m[1] ? -1 : undefined));
    return Number.isFinite(value) ? value : word;
  };
  const value = () => {
    space();
    const ch = text[i];
    if (ch === "{") {
      i++;
      const out = {};
      space();
      if (text[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        space();
        const key = text[i] === '"' || text[i] === "'" ? quoted() : bare();
        expect(":");
        Object.defineProperty(out, key, {
          value: value(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        space();
        if (text[i] === ",") {
          i++;
          continue;
        }
        expect("}");
        return out;
      }
    }
    if (ch === "[") {
      i++;
      space();
      // Typed array prefix: [B; ...], [I; ...], [L; ...].
      if (/[BIL]/.test(text[i] ?? "") && text[i + 1] === ";") i += 2;
      const out = [];
      space();
      if (text[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        out.push(value());
        space();
        if (text[i] === ",") {
          i++;
          continue;
        }
        expect("]");
        return out;
      }
    }
    if (ch === '"' || ch === "'") return quoted();
    return scalar(bare());
  };
  const result = value();
  space();
  return { value: result, end: i };
}

const quote = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Integers within int range stay plain; larger ones get `L`, fractions `d`. */
export function serializeSnbt(value) {
  if (typeof value === "boolean") return value ? "1b" : "0b";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("SNBT number not finite");
    if (!Number.isInteger(value)) return `${value}d`;
    return value >= -2147483648 && value <= 2147483647
      ? String(value)
      : `${value}L`;
  }
  if (Array.isArray(value)) return `[${value.map(serializeSnbt).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${BARE.test(k) ? k : quote(k)}:${serializeSnbt(v)}`)
      .join(",")}}`;
  throw new TypeError(`SNBT cannot represent ${value}`);
}

/**
 * Reads the reply to `data get storage <id>`. Returns the stored compound, or
 * null when the storage holds nothing. Throws on any other reply (unknown
 * command, permission error, malformed SNBT).
 *
 * Vanilla RCON collects every client's command output in one buffer, so with
 * several clients connected (bot hosts polling, the operator CLI) a reply can
 * carry another command's text before or after this one. Only the
 * `Storage <id> has the following contents: {...}` part is read.
 */
export function parseStorageReply(reply, id) {
  const text = String(reply ?? "")
    .replace(/§./g, "")
    .trim();
  const marker = "has the following contents:";
  const head = id ? `Storage ${id} ${marker}` : null;
  const at = head ? text.indexOf(head) : text.indexOf(marker);
  if (at >= 0) {
    const start = at + (head ? head.length : marker.length);
    const { value } = parseSnbtPrefix(text.slice(start));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Storage contents are not a compound");
    return Object.keys(value).length ? value : null;
  }
  if (/Found no elements matching/.test(text)) return null;
  const other = /Storage (\S+) has the following contents:/.exec(text);
  if (other)
    throw new Error(`Reply is for another storage: Storage ${other[1]}`);
  throw new Error(`Unrecognised storage reply: ${text.slice(0, 200)}`);
}
