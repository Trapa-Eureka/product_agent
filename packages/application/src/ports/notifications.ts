import type { RealtimeNotification } from "@pca/contracts";

/**
 * The in-process notification bus (TASK-404).
 *
 * Use cases and the job tracker publish here; the WebSocket gateway
 * subscribes here. Neither side knows the other exists, and nothing that is
 * published is state: every notification restates something a record
 * already holds.
 */
export type NotificationListener = (notification: RealtimeNotification) => void;

export interface NotificationHub {
  publish(notification: RealtimeNotification): void;
  subscribe(listener: NotificationListener): () => void;
}
