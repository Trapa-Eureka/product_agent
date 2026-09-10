import type { Proposal } from "@pca/contracts";

import type { JobTracker } from "../jobs/job-tracker";
import type { Clock, NotificationHub, NotificationListener, RepositorySet } from "../ports";

/**
 * Realtime notifications (TASK-404, ARCHITECTURE.md §11).
 *
 * Two sources feed the hub: job events from the tracker, and proposal status
 * from the one place every proposal status change passes through, the
 * proposal repository's `save`. Decorating the repository means creation,
 * validation, decision, apply, and failure all notify without any use case
 * knowing about sockets, and a status the client hears is always one the
 * record already holds, because the save completed first.
 */

export const createNotificationHub = (): NotificationHub => {
  const listeners = new Set<NotificationListener>();
  return {
    publish: (notification) => {
      for (const listener of listeners) listener(notification);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** Job events go out as they are recorded. Returns the unsubscribe function. */
export const forwardJobEvents = (tracker: JobTracker, hub: NotificationHub): (() => void) =>
  tracker.onEvent((event) => {
    hub.publish({ type: "job", event });
  });

/** A repository set whose proposal saves also notify, after the save succeeds. */
export const withProposalNotifications = (
  repositories: RepositorySet,
  hub: NotificationHub,
  clock: Clock,
): RepositorySet => ({
  ...repositories,
  proposals: {
    ...repositories.proposals,
    save: async (proposal: Proposal) => {
      await repositories.proposals.save(proposal);
      hub.publish({
        type: "proposal",
        proposal: {
          productionId: proposal.productionId,
          proposalId: proposal.id,
          changeRequestId: proposal.changeRequestId,
          status: proposal.status,
          validationStatus: proposal.validationStatus,
          summary: proposal.summary,
          occurredAt: clock.now(),
        },
      });
    },
  },
});
