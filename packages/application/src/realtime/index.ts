import type { Proposal } from "@pca/contracts";

import type { JobTracker } from "../jobs/job-tracker";
import type { Clock, NotificationHub, NotificationListener, RepositorySet } from "../ports";

/**
 * Realtime notifications (TASK-404, ARCHITECTURE.md §11).
 *
 * Two sources feed the hub: job events from the tracker, and proposal status
 * from the three repository operations a proposal status change passes
 * through — `proposals.save` (creation, validation, apply failure), and the
 * two atomic writes that carry a status with them, `recordProposalDecision`
 * (TASK-902) and `applyProposalTransaction` (TASK-901). Decorating the
 * repository means every status notifies without any use case knowing about
 * sockets, and a status the client hears is always one the record already
 * holds, because the write completed first. An atomic write that did not
 * land (version mismatch, decision already recorded) notifies nothing.
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

/** A repository set whose proposal status writes also notify, after each write succeeds. */
export const withProposalNotifications = (
  repositories: RepositorySet,
  hub: NotificationHub,
  clock: Clock,
): RepositorySet => {
  const notify = (proposal: Proposal): void => {
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
  };

  return {
    ...repositories,
    proposals: {
      ...repositories.proposals,
      save: async (proposal: Proposal) => {
        await repositories.proposals.save(proposal);
        notify(proposal);
      },
    },
    recordProposalDecision: async (commit) => {
      const outcome = await repositories.recordProposalDecision(commit);
      if (outcome.status === "RECORDED") {
        notify(commit.proposal);
      }
      return outcome;
    },
    applyProposalTransaction: async (commit) => {
      const outcome = await repositories.applyProposalTransaction(commit);
      if (outcome.status === "COMMITTED") {
        notify(commit.proposal);
      }
      return outcome;
    },
  };
};
