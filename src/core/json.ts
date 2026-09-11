/** JSON.stringify that survives the engine's bigint row values: a COUNT(*)
 * or a 64-bit column comes off the local engine as a bigint, which
 * JSON.stringify refuses. Rendered as a number, the way the platform's own
 * rows arrive. On its own so the hosted client can use it without importing
 * the searcher (which imports the local engine). */
export function jsonify(value: unknown, pretty = false): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? Number(v) : v),
    pretty ? 2 : undefined,
  );
}
