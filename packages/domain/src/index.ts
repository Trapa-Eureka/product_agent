/**
 * The production domain: entities, invariants, and the deterministic rules that
 * decide what is true about a production.
 *
 * This package imports no HTTP server, database driver, cloud SDK, MCP
 * transport, or model SDK, and an ESLint rule enforces that rather than trusting
 * anyone to remember it. Entity shapes come from `@pca/contracts` as types, so a
 * field cannot mean one thing here and another on the wire.
 *
 * If the AI provider, database, or MCP transport were replaced tomorrow, every
 * test in this package should still pass unchanged (ARCHITECTURE.md §17).
 */
export * from "./dates";
export * from "./production-state";
export * from "./requirements";
export * from "./digest";
export * from "./operations";
export * from "./invariants";
export * from "./impact";
export * from "./candidates";

/** Re-exported so consumers can depend on the domain alone for entity types. */
export type {
  CallSheet,
  CastMember,
  Conflict,
  EntityId,
  EntityType,
  Impact,
  ImpactReasonCode,
  ImpactSeverity,
  LocalDate,
  Location,
  Production,
  ProductionVersion,
  Proposal,
  ProposedOperation,
  Requirement,
  RequirementType,
  Scene,
  ShootDay,
  Task,
  TypedChange,
} from "@pca/contracts";
