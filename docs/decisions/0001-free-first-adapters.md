# ADR-0001: Free-first default adapters

Date: 2026-09-10  
Status: Accepted

## Context

The documented target stack (MongoDB, AWS Bedrock, AWS SQS, OpenSearch, Terraform on AWS)
mirrors the engineering environment this portfolio project is aimed at. It is built and funded
by a single independent developer with no budget for metered cloud services, and it must be
publishable to npm so that anyone can run it with `npx` on a clean machine.

A package that requires a MongoDB server, a hosted LLM, or an AWS account at runtime cannot
satisfy that goal. `ARCHITECTURE.md` already places all of these behind ports, and `CLAUDE.md`
rule 12 requires deterministic local adapters for every external service.

## Options

1. Keep the target stack as the only runtime; document that users must provision Mongo/AWS.
2. Replace the target stack outright with free components and drop Mongo/Bedrock/SQS.
3. Keep the target-stack adapters in the codebase, but make free zero-install adapters the runtime default.

## Decision

Option 3.

| Concern | Default (free)                                          | Target adapter kept for portfolio                        |
| ------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Store   | JSON file store, atomic writes, version field preserved | MongoDB (tested via mongodb-memory-server)               |
| Model   | Rule-based interpreter; Ollama auto-detected            | Bedrock (code + mocked-client tests only, no live calls) |
| Queue   | In-process queue                                        | SQS (deferred until an AWS account exists)               |
| Search  | none                                                    | OpenSearch (excluded from MVP)                           |

Selection is by environment variable (`PCA_STORAGE`, `PCA_MODEL`). Domain and application
packages are unaware of the choice.

## Consequences

- The full product, including MCP server, UI, realtime, approval, and audit, runs with `npx` and no credentials.
- Free-form natural language beyond the documented sentence patterns needs a user-installed Ollama; that is free but uses local resources.
- The file store is single-process. Multi-writer deployments switch to Mongo.
- Bedrock, SQS, and Terraform `apply` remain unexercised live; their code exists but is marked DEFERRED in `TASKS.md`.
- Cost of publishing: zero (public npm package, free account).
