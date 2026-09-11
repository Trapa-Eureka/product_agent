import type { ActorType, EntityId, ToolError } from "@pca/contracts";
import { actorIdSchema, entityIdSchema } from "@pca/contracts";

/**
 * Server-side context (MCP.md §3).
 *
 * The agent never chooses who it is or which productions it may touch. Both
 * are fixed when the server starts, from the environment, and every tool call
 * is checked against them before any handler runs. A tool input still names a
 * `productionId`, because the contract is explicit about scope, but naming one
 * outside the allow-list is refused with TOOL_UNAUTHORIZED.
 *
 * The allow-list fails closed (TASK-915, SEC-002 / AUD-003): an unset,
 * blank, or `*` `PCA_ALLOWED_PRODUCTIONS` is a startup error unless
 * `PCA_DEMO_MODE=true` says this is a local demo, so a deployment that
 * forgot the variable does not come up with access to every production.
 * Every listed ID must be a valid entity ID; a typo fails startup too.
 */

export type ServerContext = {
  readonly actor: { readonly type: ActorType; readonly id: string };
  /** `"*"` only for local demos; a deployment always lists productions. */
  readonly allowedProductionIds: readonly EntityId[] | "*";
};

export type Environment = Readonly<Record<string, string | undefined>>;

const ALLOW_LIST_HELP =
  "List the production IDs this server may act on, comma-separated (PCA_ALLOWED_PRODUCTIONS=PROD-DEMO,PROD-2), or set PCA_DEMO_MODE=true for a local demo that may act on every production.";

/** Parses PCA_ALLOWED_PRODUCTIONS; throws rather than widening to `*` without an explicit demo. */
export const allowedProductionsFromEnv = (env: Environment): readonly EntityId[] | "*" => {
  const demo = env["PCA_DEMO_MODE"]?.trim().toLowerCase() === "true";
  const raw = env["PCA_ALLOWED_PRODUCTIONS"]?.trim() ?? "";
  const entries = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (entries.length === 0 || raw === "*") {
    if (!demo) {
      throw new Error(
        `PCA_ALLOWED_PRODUCTIONS is ${raw === "*" ? '"*"' : "not set"}, which would let this server act on every production. ${ALLOW_LIST_HELP}`,
      );
    }
    return "*";
  }
  return entries.map((entry) => {
    const parsed = entityIdSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(
        `PCA_ALLOWED_PRODUCTIONS entry "${entry}" is not a valid production ID: ${(parsed.error.issues[0]?.message ?? "invalid").replace(/\.$/u, "")}. ${ALLOW_LIST_HELP}`,
      );
    }
    return parsed.data;
  });
};

export const contextFromEnv = (env: Environment): ServerContext => {
  const allowedProductionIds = allowedProductionsFromEnv(env);

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
