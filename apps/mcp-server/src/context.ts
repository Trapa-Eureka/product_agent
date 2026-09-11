import type { ActorType, EntityId, ToolError } from "@pca/contracts";
import { actorIdSchema } from "@pca/contracts";

/**
 * Server-side context (MCP.md §3).
 *
 * The agent never chooses who it is or which productions it may touch. Both
 * are fixed when the server starts, from the environment, and every tool call
 * is checked against them before any handler runs. A tool input still names a
 * `productionId`, because the contract is explicit about scope, but naming one
 * outside the allow-list is refused with TOOL_UNAUTHORIZED.
 */

export type ServerContext = {
  readonly actor: { readonly type: ActorType; readonly id: string };
  /** `"*"` only for local demos; a deployment always lists productions. */
  readonly allowedProductionIds: readonly EntityId[] | "*";
};

export type Environment = Readonly<Record<string, string | undefined>>;

export const contextFromEnv = (env: Environment): ServerContext => {
  const raw = env["PCA_ALLOWED_PRODUCTIONS"];
  const allowedProductionIds =
    raw === undefined || raw.trim() === "" || raw.trim() === "*"
      ? "*"
      : raw
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);

  // TASK-906: the actor named here is written into every audit event and
  // approval this server records, so it must satisfy the same limit those
  // records enforce — refused loudly at startup, not discovered as an
  // unreadable store later.
  const actor = actorIdSchema.safeParse(env["PCA_ACTOR_ID"] ?? "mcp-agent");
  if (!actor.success) {
    throw new Error(
      `PCA_ACTOR_ID must be 1 to 200 characters: ${actor.error.issues[0]?.message ?? "invalid"}. ` +
        `Unset it for the default "mcp-agent".`,
    );
  }

  return {
    actor: { type: "AGENT", id: actor.data },
    allowedProductionIds,
  };
};

export const authorize = (context: ServerContext, productionId: EntityId): ToolError | null => {
  if (context.allowedProductionIds === "*" || context.allowedProductionIds.includes(productionId)) {
    return null;
  }
  return {
    code: "TOOL_UNAUTHORIZED",
    message: `This server is not permitted to act on production ${productionId}.`,
    actual: productionId,
    nextStep: "Use a production this server was started for, or ask an operator to add it.",
  };
};
