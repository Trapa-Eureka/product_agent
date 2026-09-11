/**
 * Cheap probes for readiness (TASK-931, AUD-021).
 *
 * `/health` says the process is alive; `/ready` says it can do its job. The
 * second needs one question answered by each adapter that owns a resource:
 * can the store be reached right now, and is a writer holding its lock? A
 * probe is cheap by contract — a `stat`, a `ping` — never a full read, and
 * its answer names nothing secret (no URI, no path with a user in it).
 */
export type StoreHealth = {
  readonly kind: "file" | "memory" | "mongo";
  readonly ok: boolean;
  /** One short sentence when not ok; never a connection string or a stack. */
  readonly detail?: string;
  /** File store only: another writer holds the data-file lock right now. */
  readonly lockHeld?: boolean;
};

export type StoreProbe = () => Promise<StoreHealth>;
