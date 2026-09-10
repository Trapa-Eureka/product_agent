/**
 * Test doubles, builders, and scenario helpers.
 *
 * Nothing here is shipped to users. The fake model adapter (TASK-302) and the
 * queue contract suite (TASK-401) live here; the in-process queue itself is
 * a runtime adapter in `@pca/memory-queue`.
 */
export * from "./scenario";
export * from "./repository-contract";
export * from "./determinism";
export * from "./golden-scenarios";
export * from "./fake-model";
export * from "./queue-contract";
