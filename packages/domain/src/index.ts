/**
 * Framework-independent production domain.
 *
 * Entities and invariants INV-1..INV-8 arrive in TASK-003. This package must
 * never import Express, MongoDB, AWS, MCP, Angular, or any model SDK; the
 * boundary is enforced by ESLint, not by convention.
 */
export const PACKAGE_NAME = "@pca/domain";
