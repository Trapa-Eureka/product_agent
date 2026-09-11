# Deployment baseline

The reproducible artifact and the settings a deployment must have before it
is exposed to anyone but its operator (TASK-930, AUD-015 / AUD-016). Local
development and the demo need none of this: `PCA_DEMO_MODE=true` and
nothing else runs the golden scenarios (README "Run the API").

## The artifact

`Dockerfile` at the repository root builds one image from a clean checkout:
Node 22, the pnpm version pinned in `package.json`, every dependency from
the lockfile (`--frozen-lockfile`), no install scripts, a non-root `pca`
user, the data directory on a `/data` volume created `0700`, a health check
on `/api/health`. CI builds it on every push and pull request and boots the
demo from it (`artifact` job in `.github/workflows/ci.yml`). The same image
runs the MCP server (`node --import tsx apps/mcp-server/src/main.ts`).

```bash
docker build -t production-change-agent .
docker run --rm -p 3000:3000 -e PCA_DEMO_MODE=true -e PCA_STORAGE=memory production-change-agent
```

The console is a static build (`pnpm --filter @pca/web build`) served by a
host or proxy that applies the headers in ARCHITECTURE.md §6 and proxies
`/api` and `/ws` to the API.

## Checklist

Every item is enforced by the server where it can be; the rest is the
operator's. "Refused" means the server does not start.

| Area | Setting | Enforced |
|---|---|---|
| Demo off | `PCA_DEMO_MODE` unset | A demo issues tokens to anyone |
| Identity | `PCA_AUTH_SECRET` set, 32+ chars, rotated on suspicion; tokens minted with `pnpm run token` per person, with `--ttl` | Refused without a secret or demo |
| Maker-checker | `PCA_MAKER_CHECKER` left `true` | Default in token mode |
| Productions | `PCA_ALLOWED_PRODUCTIONS` lists the productions this instance serves | Refused when unset or `*` outside demo |
| Browser origins | `PCA_ALLOWED_ORIGINS` lists the console's origin(s) exactly | Foreign Origin refused (403) |
| TLS | The API and console are reached over TLS only; `PCA_TLS_TERMINATED=true` so answers carry HSTS | HSTS only when set |
| Quotas | `PCA_RATE_LIMIT_PER_MINUTE`, `PCA_WRITE_LIMIT_PER_MINUTE` sized to the team | Defaults 600 / 60 |
| Database | `PCA_STORAGE=mongo` with `PCA_MONGO_URI` over TLS (`mongodb+srv://` or `tls=true`) and credentials; a replica set | Refused otherwise outside demo |
| File store | Only for a single operator; `PCA_DATA_FILE_PERMISSIONS=refuse` so a loose file stops startup | Symlinks refused; loose file tightened or refused |
| Process | Run the image as shipped (non-root, read-only root filesystem if the platform allows, `/data` as the only writable volume) | Image default |
| Headers | The proxy or static host serving the console sets the CSP and companion headers in ARCHITECTURE.md §6 | API answers hardened by default |
| Readiness | Gate traffic on `GET /api/ready` (503 until the store answers); alert on rising `queue.deadLettered`, `jobs.inFlight`, or `rateLimit.rejectedRequests` | Route |
| Logs | Ship stderr (JSON lines) to the log store; `job_infrastructure_failure`, `model_output_rejected`, `store_*` warnings, and `auth_demo_mode` are the lines to alert on | — |
| Backups | Back up the database (or `/data`) on the platform's schedule; the audit trail is the record of every consequential change | — |
| Updates | Merge Dependabot's action and dependency pull requests after CI; `pnpm audit` fails the build on a known advisory | CI |

## What the baseline does not cover

Per-field access control, encryption at rest beyond what the database
provides, an identity provider (tokens are minted by the operator), a
durable queue (in-process; the deferred SQS adapter), and a trusted-proxy
address for the rate limiter (the client address is the socket's).
