// Shared wire contract only: no bot, transport, credentials or runtime state.
export const wireStringify = (value) =>
  JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? { $arenaBigInt: v.toString() } : v,
  );
export const parseWire = (text) =>
  JSON.parse(text, (_key, value) =>
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    typeof value.$arenaBigInt === "string" &&
    /^-?[0-9]{1,80}$/.test(value.$arenaBigInt)
      ? BigInt(value.$arenaBigInt)
      : value,
  );
export const controls = Object.freeze([
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sprint",
  "sneak",
]);
