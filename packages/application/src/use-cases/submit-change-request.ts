import type {
  AuditEvent,
  AuditSubjectType,
  ChangeRequest,
  EntityId,
  TypedChange,
} from "@pca/contracts";
import { typedChangeSchema } from "@pca/contracts";
import { indexProduction } from "@pca/domain";

import type { Clock, IdFactory, RepositorySet } from "../ports";
import { firstMissingReference } from "../references";
import type { UseCaseResult } from "../result";
import { fail, succeed } from "../result";

/**
 * Change intake (SPEC.md FR-1, TASK-103).
 *
 * This is the first deterministic checkpoint after a change leaves the AI
 * layer. Whatever interpreted the sentence, the IDs it produced are confirmed
 * against this production's real data here, so an invented or misattributed
 * entity is refused before anything is persisted or analysed (SPEC.md §6).
 *
 * The raw sentence is stored verbatim beside the typed change so the audit
 * trail shows what the user actually said, not only what the system made of it.
 */

export type SubmitChangeRequestInput = {
  readonly productionId: EntityId;
  readonly rawText: string;
  /** Already resolved to IDs. Resolution from names is TASK-304's job. */
  readonly change: TypedChange;
  readonly createdBy: string;
  /** Supplied by the transport when the request is part of a larger trace. */
  readonly correlationId?: string;
};

export type SubmitChangeRequestDependencies = {
  readonly repositories: RepositorySet;
  readonly clock: Clock;
  readonly ids: IdFactory;
};

export type SubmitChangeRequest = (
  input: SubmitChangeRequestInput,
) => Promise<UseCaseResult<ChangeRequest>>;

/** The entity the audit trail should file this change under. */
const subjectOf = (change: TypedChange): { type: AuditSubjectType; id: EntityId } => {
  switch (change.type) {
    case "CAST_UNAVAILABLE":
      return { type: "CAST_MEMBER", id: change.castId };
    case "LOCATION_UNAVAILABLE":
      return { type: "LOCATION", id: change.locationId };
    case "SCENE_REQUIREMENT_CHANGED":
      return { type: "SCENE", id: change.sceneId };
    case "SCHEDULE_CHANGED":
      return { type: "SHOOT_DAY", id: change.toShootDayId };
  }
};

export const createSubmitChangeRequest = (
  dependencies: SubmitChangeRequestDependencies,
): SubmitChangeRequest => {
  const { repositories, clock, ids } = dependencies;

  return async (input) => {
    const correlationId = input.correlationId ?? ids.next("corr");

    // Defence in depth: the transport validated this, but an orchestrator
    // feeding model output straight in must hit the same wall.
    const parsed = typedChangeSchema.safeParse(input.change);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(
        "INVALID_INPUT",
        `The typed change is malformed: ${issue?.message ?? "unknown issue"}.`,
        {
          correlationId,
          actual: issue?.path.join(".") ?? "<root>",
          nextStep:
            "Re-run interpretation and submit a change that matches the TypedChange schema.",
        },
      );
    }
    const change = parsed.data;

    const rawText = input.rawText.trim();
    if (rawText.length === 0) {
      return fail("INVALID_INPUT", "A change request must record what the user said.", {
        correlationId,
        nextStep: "Submit the user's original sentence as rawText.",
      });
    }

    const state = await repositories.productions.loadState(input.productionId);
    if (state === null) {
      return fail("ENTITY_NOT_FOUND", `Production ${input.productionId} does not exist.`, {
        correlationId,
        actual: input.productionId,
        nextStep: "Call get_production with a known production ID.",
      });
    }

    const index = indexProduction(state);
    const missing = firstMissingReference(index, change);
    if (missing !== null) {
      return fail(
        "ENTITY_NOT_FOUND",
        `No ${missing.kind} ${missing.id} exists in production ${input.productionId}.`,
        {
          correlationId,
          actual: missing.id,
          nextStep: `Resolve the ${missing.kind} with ${missing.lookupTool} and submit the ID it returns.`,
        },
      );
    }

    const createdAt = clock.now();
    const changeRequest: ChangeRequest = {
      id: ids.next("CR"),
      productionId: input.productionId,
      type: change.type,
      rawText,
      payload: change,
      correlationId,
      createdBy: input.createdBy,
      createdAt,
    };

    const subject = subjectOf(change);
    const auditEvent: AuditEvent = {
      id: ids.next("AE"),
      productionId: input.productionId,
      actorType: "USER",
      actorId: input.createdBy,
      action: "CHANGE_REQUEST_SUBMITTED",
      entityType: subject.type,
      entityId: subject.id,
      correlationId,
      metadata: { changeRequestId: changeRequest.id, changeType: change.type, rawText },
      createdAt,
    };

    await repositories.changeRequests.save(changeRequest);
    await repositories.auditEvents.append(auditEvent);

    return succeed(changeRequest);
  };
};
