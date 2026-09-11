import type { Document } from "mongodb";

/**
 * TASK-926 (SEC-015 / AUD-020): workflow and authorization documents are
 * parsed with their strict contract schemas on every read and validated on
 * every write, as the file store already did — a partial migration, an
 * operator's hand edit, or an older writer cannot hand a malformed
 * approval, proposal, or idempotency row to a guard as if it were typed.
 * A failure names the collection, the row, and the path, never a value.
 *
 * `Schema` is the slice of a Zod schema this needs, so the adapter depends
 * on the contracts, not on Zod.
 */
export type Schema<T> = {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly { path: PropertyKey[]; message: string }[] };
      };
};

const describe = (issue: { path: PropertyKey[]; message: string } | undefined): string =>
  `"${issue?.path.map(String).join(".") ?? "<root>"}": ${issue?.message ?? "invalid"}`;

/** A stored row as its contract type, with Mongo's own fields stripped; `STORE_CORRUPT` otherwise. */
export const parseRow = <T>(schema: Schema<T>, collection: string, row: Document): T => {
  const { _id: id, _rev: _rev, ...record } = row;
  const parsed = schema.safeParse(record);
  if (parsed.success) return parsed.data;
  throw new Error(
    `STORE_CORRUPT: ${collection} row ${String(id)} in MongoDB does not match the expected shape at ` +
      `${describe(parsed.error.issues[0])}. Restore it from a backup or re-seed the production.`,
  );
};

/** Refuses to write a record the contract would refuse to read back; `STORE_INVALID_WRITE`. */
export const validated = <T>(schema: Schema<T>, collection: string, id: string, record: T): T => {
  const parsed = schema.safeParse(record);
  if (parsed.success) return parsed.data;
  throw new Error(
    `STORE_INVALID_WRITE: refusing to write ${collection} row ${id} to MongoDB at ` +
      `${describe(parsed.error.issues[0])}. Nothing was written.`,
  );
};
