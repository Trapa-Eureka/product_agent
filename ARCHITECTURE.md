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
│   ├── application/         # use cases / commands / queries
│   ├── contracts/           # zod/types shared across boundaries
│   ├── adapters/            # Mongo/AWS/model/search adapters
│   ├── fixtures/            # deterministic Demo Movie
│   └── test-support/        # fakes/mocks/builders
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
