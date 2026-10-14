import { timingSafeEqual } from "node:crypto";

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function bearerMatches(header, token) {
  const supplied = Buffer.from(header ?? ""),
    expected = Buffer.from(`Bearer ${token}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
