import type {
  AgentJobEvent,
  JobRun,
  Proposal,
  ProposalStatusNotification,
  RealtimeClientMessage,
  RealtimeServerMessage,
  RecoverySnapshot,
} from "@pca/contracts";
import { OPEN_PROPOSAL_STATUSES, realtimeServerMessageSchema } from "@pca/contracts";

/**
 * Reconnecting realtime client (TASK-405, ARCHITECTURE.md §11).
 *
 * The rule it implements: the socket tells you *that* something changed; the
 * records tell you *what*. So, on every connection (first or re-established)
 * the client re-subscribes to the productions it follows, waits for the
 * server to acknowledge each subscription, and only then recovers the
 * production by reading the snapshot over REST. That order closes the gap:
 * anything that happens after the acknowledgement arrives live, and the
 * snapshot, read after it, covers everything before. Notifications that
 * arrive while a recovery is in flight are held and applied after the
 * snapshot. A notification about a job or proposal the
 * view does not know triggers another recovery rather than a guess, and a
 * notification the record already reflects is ignored.
 *
 * Two rules added by TASK-910 (code review #11, #12). A proposal that
 * reaches a terminal status (`APPLIED`, `REJECTED`, `FAILED`) leaves
 * `openProposals`, because that array's contract is what a coordinator still
 * has to act on; and `APPLIED` also triggers a recovery, because the write
 * moved the production version (INV-7) and only the record says to what. And
 * a recovery read that fails does not give up: the held notifications stay
 * held, the view stays `recovering` so what arrives next is held too, and
 * the read is retried with the same bounded backoff as reconnection until it
 * succeeds or the socket drops (whereupon reconnection recovers from
 * scratch). Applying a live notification without a baseline would be a
 * guess, and never trying again would leave the view stale for as long as
 * the socket stayed quiet.
 *
 * Framework-independent: the socket constructor, the timer, and the
 * recovery fetch are injected, so the same code runs in a browser, under
 * Node with `ws`, and in a test with fakes.
 */

/** The subset of the browser `WebSocket` (and `ws`) the client uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export const SOCKET_OPEN = 1;

export type ClientStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export type ProposalView = Proposal;

/** What the client keeps per followed production: recovered records plus what live notifications have changed. */
export type ProductionView = {
  readonly productionId: string;
  readonly productionVersion: number | null;
  /** Newest first. */
  readonly jobs: readonly JobRun[];
  readonly openProposals: readonly ProposalView[];
  readonly recoveredAt: string | null;
  readonly recovering: boolean;
};

export type RealtimeClientOptions = {
  readonly url: string;
  readonly createSocket: (url: string) => SocketLike;
  /** Reads the canonical snapshot, typically `GET /api/productions/:id/recovery`. */
  readonly recover: (productionId: string) => Promise<RecoverySnapshot>;
  /** Runs `task` after `delayMs`; returns a cancel. Defaults to `setTimeout`. */
  readonly schedule?: (task: () => void, delayMs: number) => () => void;
  /**
   * Delay before reconnect attempt `attempt` (1-based), and before recovery
   * retry `attempt` after that many consecutive failed reads. Default: 500 ms
   * doubling, capped at 30 s.
   */
  readonly backoffMs?: (attempt: number) => number;
  readonly onChange?: (view: ProductionView) => void;
  readonly onStatus?: (status: ClientStatus, attempt: number) => void;
  /**
   * Called each time a recovery read fails. The client keeps holding
   * notifications and retries the read with backoff while the socket stays
   * up; a reconnect starts recovery over.
   */
  readonly onRecoveryError?: (productionId: string, error: unknown) => void;
};

export interface RealtimeClient {
  connect(): void;
  follow(productionId: string): void;
  unfollow(productionId: string): void;
  /** Reads the snapshot again now, without waiting for a notification. */
  recover(productionId: string): Promise<void>;
  view(productionId: string): ProductionView | null;
  status(): ClientStatus;
  reconnectAttempts(): number;
  close(): void;
}

const defaultBackoff = (attempt: number): number => Math.min(500 * 2 ** (attempt - 1), 30_000);

const defaultSchedule = (task: () => void, delayMs: number): (() => void) => {
  const handle = setTimeout(task, delayMs);
  return () => clearTimeout(handle);
};

const textOf = (data: unknown): string =>
  typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);

const sameEvent = (left: AgentJobEvent, right: AgentJobEvent): boolean =>
  left.stage === right.stage &&
  left.status === right.status &&
  left.occurredAt === right.occurredAt &&
  left.message === right.message;

/** Merges a job event into a run. `null` means the run already reflects it. */
export const applyJobEvent = (run: JobRun, event: AgentJobEvent): JobRun | null => {
  if (event.jobId !== run.id) return null;
  if (run.history.some((known) => sameEvent(known, event))) return null;
  if (event.occurredAt < run.updatedAt) return null;
  return {
    ...run,
    stage: event.status === "FAILED" ? "failed" : event.stage,
    status: event.status,
    ...(event.message === undefined ? {} : { message: event.message }),
    history: [...run.history, event],
    updatedAt: event.occurredAt,
  };
};

/** Merges a proposal status into a known proposal. `null` means it already reflects it. */
export const applyProposalNotification = (
  proposal: Proposal,
  notification: ProposalStatusNotification,
): Proposal | null => {
  if (notification.proposalId !== proposal.id) return null;
  if (
    proposal.status === notification.status &&
    proposal.validationStatus === notification.validationStatus &&
    proposal.summary === notification.summary
  ) {
    return null;
  }
  return {
    ...proposal,
    status: notification.status,
    validationStatus: notification.validationStatus,
    summary: notification.summary,
  };
};

/** Whether a proposal in this status still belongs in `openProposals`. */
export const isOpenProposalStatus = (status: Proposal["status"]): boolean =>
  (OPEN_PROPOSAL_STATUSES as readonly string[]).includes(status);

type FollowedProduction = {
  view: ProductionView;
  /** Notifications received while a recovery was in flight or awaiting retry. */
  held: RealtimeServerMessage[];
  /** A notification asked for another recovery while one was running. */
  dirty: boolean;
  /** Consecutive failed recovery reads; drives the retry backoff. Reset by a successful read. */
  recoveryFailures: number;
  /** Cancels the retry scheduled after a failed read, when one is pending (no read in flight). */
  cancelRetry: (() => void) | null;
};

export const createRealtimeClient = (options: RealtimeClientOptions): RealtimeClient => {
  const schedule = options.schedule ?? defaultSchedule;
  const backoff = options.backoffMs ?? defaultBackoff;

  const followed = new Map<string, FollowedProduction>();
  let socket: SocketLike | null = null;
  let status: ClientStatus = "idle";
  let attempts = 0;
  let cancelReconnect: (() => void) | null = null;
  let closedByUser = false;

  const setStatus = (next: ClientStatus): void => {
    status = next;
    options.onStatus?.(next, attempts);
  };

  const emptyView = (productionId: string): ProductionView => ({
    productionId,
    productionVersion: null,
    jobs: [],
    openProposals: [],
    recoveredAt: null,
    recovering: false,
  });

  const update = (entry: FollowedProduction, view: ProductionView): void => {
    entry.view = view;
    options.onChange?.(view);
  };

  const send = (message: RealtimeClientMessage): void => {
    if (socket !== null && socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify(message));
  };

  /** Forgets a pending retry. Returns whether there was one. */
  const cancelRetry = (entry: FollowedProduction): boolean => {
    if (entry.cancelRetry === null) return false;
    entry.cancelRetry();
    entry.cancelRetry = null;
    return true;
  };

  /**
   * Abandons an unfinished recovery: what was held is dropped and the view
   * stops holding, so the next `subscribed` starts recovery from scratch.
   * Only for a recovery that is awaiting retry or whose socket is gone; a
   * read still in flight keeps its own bookkeeping.
   */
  const abandonRecovery = (entry: FollowedProduction): void => {
    entry.held = [];
    entry.dirty = false;
    if (cancelRetry(entry)) update(entry, { ...entry.view, recovering: false });
  };

  const recoverProduction = async (productionId: string): Promise<void> => {
    const entry = followed.get(productionId);
    if (entry === undefined) return;
    if (cancelRetry(entry)) {
      // A retry was waiting; this request is that retry, run now.
    } else if (entry.view.recovering) {
      entry.dirty = true;
      return;
    }
    await readSnapshot(entry);
  };

  const readSnapshot = async (entry: FollowedProduction): Promise<void> => {
    const { productionId } = entry.view;
    if (!entry.view.recovering) update(entry, { ...entry.view, recovering: true });
    let snapshot: RecoverySnapshot;
    try {
      snapshot = await options.recover(productionId);
    } catch (error) {
      if (followed.get(productionId) !== entry) return;
      entry.recoveryFailures += 1;
      options.onRecoveryError?.(productionId, error);
      if (closedByUser) {
        abandonRecovery(entry);
        update(entry, { ...entry.view, recovering: false });
        return;
      }
      // Nothing held can be applied without a baseline, so it stays held and
      // the view keeps holding. Try the read again after a bounded delay; a
      // socket that drops meanwhile cancels this and recovers on reconnect.
      entry.cancelRetry = schedule(() => {
        entry.cancelRetry = null;
        void readSnapshot(entry);
      }, backoff(entry.recoveryFailures));
      return;
    }
    if (followed.get(productionId) !== entry) return;
    entry.recoveryFailures = 0;
    update(entry, {
      productionId,
      productionVersion: snapshot.productionVersion,
      jobs: snapshot.jobs,
      openProposals: snapshot.openProposals,
      recoveredAt: snapshot.asOf,
      recovering: false,
    });
    const held = entry.held.splice(0);
    for (const message of held) applyNotification(entry, message);
    if (entry.dirty) {
      entry.dirty = false;
      void recoverProduction(productionId);
    }
  };

  const applyNotification = (entry: FollowedProduction, message: RealtimeServerMessage): void => {
    if (entry.view.recovering) {
      entry.held.push(message);
      return;
    }
    if (message.type === "job") {
      const index = entry.view.jobs.findIndex((run) => run.id === message.event.jobId);
      const known = entry.view.jobs[index];
      if (known === undefined) {
        void recoverProduction(entry.view.productionId);
        return;
      }
      const merged = applyJobEvent(known, message.event);
      if (merged === null) return;
      const jobs = [...entry.view.jobs];
      jobs[index] = merged;
      update(entry, { ...entry.view, jobs });
      return;
    }
    if (message.type === "proposal") {
      const index = entry.view.openProposals.findIndex(
        (proposal) => proposal.id === message.proposal.proposalId,
      );
      const known = entry.view.openProposals[index];
      if (known === undefined) {
        void recoverProduction(entry.view.productionId);
        return;
      }
      const merged = applyProposalNotification(known, message.proposal);
      if (merged === null) return;
      const openProposals = [...entry.view.openProposals];
      if (isOpenProposalStatus(merged.status)) {
        openProposals[index] = merged;
      } else {
        openProposals.splice(index, 1); // Closed: nothing left for a coordinator to do with it.
      }
      update(entry, { ...entry.view, openProposals });
      if (merged.status === "APPLIED") {
        // The write moved the production version (INV-7). The notification
        // does not say to what; the record does.
        void recoverProduction(entry.view.productionId);
      }
    }
  };

  const handleMessage = (raw: unknown): void => {
    let message: RealtimeServerMessage;
    try {
      message = realtimeServerMessageSchema.parse(JSON.parse(textOf(raw)));
    } catch {
      return; // Not a message this protocol version knows; the records are still the truth.
    }
    switch (message.type) {
      case "welcome":
        attempts = 0;
        setStatus("open");
        for (const productionId of followed.keys()) send({ type: "subscribe", productionId });
        return;
      case "subscribed":
        // Only now is the socket guaranteed to carry everything after the snapshot.
        if (followed.has(message.productionId)) void recoverProduction(message.productionId);
        return;
      case "job": {
        const entry = followed.get(message.event.productionId);
        if (entry !== undefined) applyNotification(entry, message);
        return;
      }
      case "proposal": {
        const entry = followed.get(message.proposal.productionId);
        if (entry !== undefined) applyNotification(entry, message);
        return;
      }
      case "unsubscribed":
      case "pong":
      case "error":
        return;
    }
  };

  const scheduleReconnect = (): void => {
    if (closedByUser) return;
    attempts += 1;
    setStatus("reconnecting");
    cancelReconnect = schedule(() => {
      cancelReconnect = null;
      open();
    }, backoff(attempts));
  };

  const open = (): void => {
    if (closedByUser) return;
    if (status !== "reconnecting") setStatus("connecting");
    const next = options.createSocket(options.url);
    socket = next;
    next.onopen = () => undefined; // Nothing until welcome: the server speaks first.
    next.onmessage = (event) => {
      if (socket === next) handleMessage(event.data);
    };
    next.onerror = () => undefined; // A close always follows; reconnect is decided there.
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      for (const entry of followed.values()) abandonRecovery(entry);
      if (closedByUser) {
        setStatus("closed");
        return;
      }
      scheduleReconnect();
    };
  };

  return {
    connect: () => {
      if (socket !== null || cancelReconnect !== null) return;
      closedByUser = false;
      open();
    },
    follow: (productionId) => {
      if (followed.has(productionId)) return;
      const entry: FollowedProduction = {
        view: emptyView(productionId),
        held: [],
        dirty: false,
        recoveryFailures: 0,
        cancelRetry: null,
      };
      followed.set(productionId, entry);
      options.onChange?.(entry.view);
      if (status === "open") send({ type: "subscribe", productionId });
    },
    unfollow: (productionId) => {
      const entry = followed.get(productionId);
      if (entry === undefined) return;
      followed.delete(productionId);
      cancelRetry(entry);
      send({ type: "unsubscribe", productionId });
    },
    recover: recoverProduction,
    view: (productionId) => followed.get(productionId)?.view ?? null,
    status: () => status,
    reconnectAttempts: () => attempts,
    close: () => {
      closedByUser = true;
      cancelReconnect?.();
      cancelReconnect = null;
      for (const entry of followed.values()) abandonRecovery(entry);
      const current = socket;
      if (current === null) {
        setStatus("closed");
        return;
      }
      current.close(1000, "Client closed");
    },
  };
};

export { defaultBackoff as defaultReconnectBackoff };
