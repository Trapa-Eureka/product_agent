# Architecture

## 1. Technology Stack

### Frontend

- Angular
- TypeScript
- WebSocket client

### Backend

- Node.js
- Express
- TypeScript

### Database

- MongoDB

### AI / Model

- AWS Bedrock
- Provider-independent `ModelPort`
- Deterministic `FakeModelAdapter` for local testing

### Agent Integration

- Model Context Protocol (MCP)
- Explicit read / analyze / simulate / write tool contracts
- Human approval boundary for consequential writes

### Search

- AWS OpenSearch
- Optional for MVP
- Used for production document search/RAG, not dependency analysis

### Async Processing

- AWS SQS
- Dead Letter Queue
- Local deterministic queue adapter

### Realtime

- WebSocket

### Infrastructure

- AWS
- Terraform

### CI/CD

- GitLab CI

### Testing

- TypeScript strict mode
- Unit tests
- Integration tests
- MCP contract tests
- Playwright E2E
- Deterministic local mocks

### Local Development

- FakeModelAdapter
- In-memory/fake queue
- deterministic Demo Movie fixtures
- MongoDB local/test environment

## 2. Why This Stack

### Angular

Angular is intentionally used instead of the author's usual
React/Next.js stack to demonstrate the ability to work with the
frontend technology used by the target production SaaS environment.

### MongoDB

MongoDB is used as the operational data store to practice document
modeling and indexing for connected production-domain data.

### AWS Bedrock

Bedrock is used behind a provider abstraction so AI orchestration
remains independent of a specific model provider.

### SQS

Production change analysis and AI jobs can be asynchronous.
SQS provides retries, decoupling, and a production-ready queue model.

### MCP

MCP creates an explicit capability boundary between the AI agent and
the production application rather than allowing unrestricted database
or API access.

### Terraform

AWS resources are expressed as infrastructure as code so the system
can be reproduced, reviewed, and tested consistently.

### WebSocket

Realtime events expose long-running agent stages such as analysis,
simulation, approval, application, and verification.

### OpenSearch

OpenSearch is reserved for document retrieval and RAG.
It must not replace deterministic production dependency queries.

### Free-first constraint

This is an independent, self-funded portfolio project built by a single
developer. There is no budget for metered cloud services, so every
component that would bill per use has a free, zero-install adapter that is
the **runtime default**, while the target-stack adapter remains in the
codebase to demonstrate the intended production shape.

| Concern | Target adapter (portfolio) | Default adapter (free, runs anywhere)                         |
| ------- | -------------------------- | ------------------------------------------------------------- |
| Store   | MongoDB                    | JSON file store (`PCA_STORAGE=file`)                          |
| Model   | AWS Bedrock                | Rule-based interpreter, Ollama if present (`PCA_MODEL=rules`) |
| Queue   | AWS SQS                    | In-process queue                                              |
| Search  | OpenSearch                 | none (optional feature, excluded from MVP)                    |

Consequences:

- domain and application packages never see which adapter is active;
- the published npm package runs the full product on a clean machine with
  `npx` and no credentials;
- Bedrock, SQS, and Terraform `apply` are exercised only when a budget or
  AWS account exists (see `TASKS.md` items marked DEFERRED).

Decision record: `docs/decisions/0001-free-first-adapters.md`.

## 3. Goals

- Strongly typed, agent-friendly codebase
- Explicit domain boundaries
- Deterministic change analysis
- Safe MCP capability boundary
- Cloud-portable local development
- Fast automated feedback
- Architecture that exercises Angular, Node/Express, MongoDB, AWS concepts, Terraform, GitLab CI, WebSocket, and MCP

## 4. High-level architecture

```text
Angular Web App
      │ REST / WebSocket
      ▼
Express API / Application Layer
      │
      ├──────────────► Change Analysis Domain
      │                    │
      │                    └── deterministic rules
      │
      ├──────────────► MongoDB repositories
      │
      ├──────────────► Job/Queue port ──► SQS adapter
      │
      └──────────────► Agent Orchestrator
                              │
                              ├── Model port ──► Bedrock adapter
                              │
                              └── MCP Client
                                      │
                                      ▼
                                  MCP Server
                                      │
                              allow-listed tools
                                      │
                                      ▼
                              Application services
```

Important: MCP write tools call application services. They do not bypass domain rules by writing directly to MongoDB.

## 5. Suggested repository

```text
product_agent/
├── apps/
│   ├── web/                 # Angular
│   ├── api/                 # Express API
│   └── mcp-server/          # MCP transport/tool registration
├── packages/
│   ├── domain/              # entities, invariants, change engine
│   ├── application/         # use cases, and the ports they depend on
│   ├── contracts/           # zod/types shared across boundaries
│   ├── bootstrap/           # composition root: selects adapters from env
│   ├── adapters/
│   │   ├── file-store/      # JSON file repositories (default)
│   │   ├── memory-store/    # in-memory repositories
│   │   └── mongo-store/     # MongoDB repositories (TASK-102)
│   ├── fixtures/            # deterministic Demo Movie
│   └── test-support/        # fakes, builders, shared contract suites
├── infra/
│   └── terraform/
├── docs/
├── CLAUDE.md
├── SPEC.md
├── DOMAIN.md
├── DESIGN.md
├── ARCHITECTURE.md
├── MCP.md
├── TESTING.md
├── TASKS.md
└── WORKFLOW.md
```

A monorepo is recommended so shared contracts and verification can be run from one root.

## 6. Layering

### Domain

Pure TypeScript. No Express, Angular, MongoDB, AWS SDK, MCP SDK, or model SDK imports.

Owns:

- entities/value objects;
- invariants;
- dependency graph;
- impact analysis;
- proposal validation;
- schedule compatibility rules used by MVP.

### Where entity shapes live

`packages/contracts` owns the schemas and is the single source of truth for
entity shape. The domain consumes the inferred types rather than restating them,
so a field cannot mean one thing in Mongo, another in an MCP response, and a
third in the UI.

This does not weaken the domain boundary. A schema library is not a framework:
the domain still imports no HTTP server, database driver, cloud SDK, MCP
transport, or model SDK, and the ESLint boundary rule enforces that.

### Application

Coordinates use cases:

- submit change;
- resolve entities;
- analyze impact;
- simulate proposal;
- approve/reject;
- apply proposal;
- verify proposal.

Depends on interfaces/ports, not concrete infrastructure.

### Adapters

Concrete implementations:

- Mongo repositories;
- Bedrock model;
- fake deterministic model;
- SQS;
- in-memory queue;
- OpenSearch;
- WebSocket event publisher.

### Delivery

- Express HTTP routes
- WebSocket gateway
- MCP server
- Angular UI

## 7. AI architecture

Use a provider interface:

```ts
interface ModelPort {
  interpretChange(input: InterpretChangeInput): Promise<InterpretedChange>;
  explainImpact(input: ExplainImpactInput): Promise<string>;
  rankCandidates(input: RankCandidatesInput): Promise<RankedCandidate[]>;
}
```

Production target: Bedrock adapter.  
Tests/local deterministic mode: fake adapter.

Do not couple domain types to a Bedrock response shape.

Structured AI output must be schema-validated before use.

## 8. Change engine

The change engine is deterministic.

```text
Typed Change
   ↓
Dependency Resolver
   ↓
Impact Graph
   ↓
Candidate Generator
   ↓
Simulator
   ↓
Constraint Validator
   ↓
Proposal
```

The first MVP candidate generator can be simple and explicit rather than “smart”:

- find another shoot day where required cast/location are available;
- preserve scene requirements;
- return a small ordered set of valid candidates.

Optimization/constraint-solving can be added later.

## 9. MongoDB

MongoDB stores operational state and audit records.

Recommended collections:

- productions
- scenes
- castMembers
- locations
- requirements
- shootDays
- callSheets
- tasks
- changeRequests
- proposals
- approvals
- auditEvents

Use indexes for common dependency queries, e.g.:

- `scenes.productionId`
- `scenes.requiredCastIds`
- `scenes.locationId`
- `shootDays.productionId + date`
- `proposals.productionId + status`
- `auditEvents.productionId + createdAt`

Do not over-denormalize initially. Prefer clear ownership and queryability for the prototype.

### Storage adapters

The application depends on repository ports, never on a driver. Three adapters
implement them:

| Adapter | Package | Role |
|---|---|---|
| JSON file | `@pca/file-store` | Runtime default. No server, no native module, no account. |
| In-memory | `@pca/memory-store` | Unit tests and throwaway demo runs. |
| MongoDB | `@pca/mongo-store` | The portfolio target. Requires a replica set so commits are transactional; refuses a standalone server. |

One contract test suite in `@pca/test-support` runs unchanged against each of
them. An adapter that merely compiles against the ports has proved nothing;
when two adapters disagree, the disagreement must fail in that suite rather
than inside a use case that assumed one of them.

The file store is single-process: writes are serialised in-process, and two
processes writing the same file can still lose an update. Multi-writer
deployments select MongoDB. It reads through to the file on every call rather
than caching, so a second instance sees the first one's writes.

Entity rows in Mongo use a composite `_id` of `productionId::id`, so an entity
ID that repeats across productions is two rows rather than a collision, and
every read still filters by `productionId`. Audit rows keep Mongo's own
ObjectId, which increases with insertion order, so "newest first" stays correct
when two events share a timestamp.

Which adapter runs is decided in the composition root, `packages/bootstrap`,
from `PCA_STORAGE` (`file`, `memory`, or `mongo`) and its companions
(`PCA_DATA_FILE`, `PCA_MONGO_URI`, `PCA_MONGO_DB`). It is the one package that
depends on every adapter; the MCP server and the API ask it for a
`RepositorySet` and never name a driver.

## 10. Queue/SQS

Use asynchronous jobs for operations that may involve model calls or larger analysis.

Example envelope:

```ts
type JobEnvelope = {
  id: string;
  type: "ANALYZE_CHANGE" | "APPLY_PROPOSAL" | "VERIFY_PROPOSAL";
  productionId: string;
  correlationId: string;
  attempt: number;
  payload: unknown;
};
```

Requirements:

- idempotency key;
- bounded retry;
- explicit failure state;
- dead-letter strategy in AWS;
- local in-memory/fake queue with identical application contract.

## 11. Realtime/WebSocket

WebSocket publishes job state and user-visible events.

Do not make WebSocket the source of truth. The client can reconnect and fetch canonical job/proposal state via REST.

Suggested event:

```ts
type AgentJobEvent = {
  jobId: string;
  productionId: string;
  stage: string;
  status: "STARTED" | "COMPLETED" | "FAILED";
  message?: string;
  occurredAt: string;
};
```

## 12. OpenSearch

OpenSearch is **optional for initial MVP**.

Good later use:

- production-document RAG;
- searching notes/scripts/production documents;
- demonstrating migration of existing hybrid-search experience.

Do not use OpenSearch to solve deterministic entity relationships already represented in MongoDB.

## 13. MCP placement

MCP is the controlled agent interface, not the domain itself.

```text
Agent
  ↓
MCP tool
  ↓
Schema validation
  ↓
Authorization / approval checks
  ↓
Application use case
  ↓
Domain
  ↓
Repository
```

## 14. Infrastructure

Terraform target modules/resources:

- IAM roles/policies
- SQS queue + DLQ
- optional OpenSearch
- application runtime chosen during implementation
- logging/monitoring primitives

Avoid deploying expensive resources merely for portfolio completeness. Infrastructure can be validated with Terraform checks and documented plans before live deployment.

## 15. Security

- least-privilege AWS IAM;
- secrets only through environment/secret management;
- schema validation at every external boundary;
- authorization server-side;
- approval enforcement server-side;
- prompt/tool inputs treated as untrusted;
- no hidden chain-of-thought logging;
- audit structured actions/results instead.

## 16. Observability

Use correlation IDs across:

- HTTP request;
- agent job;
- MCP call;
- proposal;
- queue message.

Capture latency for:

- model calls;
- MCP tools;
- dependency analysis;
- database operations.

This creates a natural performance-debugging story similar to real production engineering.

## 17. Architecture rule of thumb

If the AI provider, MongoDB, AWS, or MCP transport were replaced tomorrow, the core change-analysis tests should still pass unchanged.
