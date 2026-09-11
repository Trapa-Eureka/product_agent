# production-change-agent

An AI production change agent for film scheduling: describe a change in a
sentence ("Sarah cannot shoot Friday."), see what it touches, and apply the
remedy only after a human approves it. The model interprets and explains;
deterministic code owns dependency analysis, constraints, approval, and every
write.

Runs on a clean machine with Node 22 or newer and nothing else: a JSON file
store under `~/.production-change-agent`, a rule-based interpreter, and an
in-process queue. No account, no database server, no API key.

```sh
npx production-change-agent seed    # restore the Demo Movie fixture
npx production-change-agent serve   # console + REST API + WebSocket at http://127.0.0.1:3000
npx production-change-agent mcp     # MCP server over stdio, for an agent host
```

Open http://127.0.0.1:3000, pick the Demo Movie, and try the three demo
sentences: "Sarah cannot shoot Friday.", "The warehouse is unavailable
Friday.", "Scene 18 now needs a red car."

## Configuration

Without `PCA_AUTH_SECRET`, `serve` and `mcp` run as the local demo
(`PCA_DEMO_MODE=true`): anyone who can reach the port acts as the demo
coordinator, so keep it on the loopback interface (the default). A deployment
sets `PCA_AUTH_SECRET` (32+ characters) and mints tokens per person; see the
repository's `README.md` "Runtime environment" and `docs/DEPLOYMENT.md`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PCA_DATA_FILE` | `~/.production-change-agent/data.json` | The file store; owner-only permissions |
| `PCA_API_HOST` / `PCA_API_PORT` | `127.0.0.1` / `3000` | Where `serve` listens |
| `PCA_STORAGE` | `file` | `file`, `memory`, or `mongo` (`PCA_MONGO_URI`, TLS and credentials required outside demo mode) |
| `PCA_MODEL` | `rules` | `rules`; `ollama` and `bedrock` are not shipped in this version |
| `PCA_ALLOWED_PRODUCTIONS` | every production in demo mode | Comma-separated production IDs a deployment may act on |
| `PCA_CONSOLE_DIR` | the console shipped in the package | A different built console to serve, or empty to serve only `/api` |

Source, architecture, and the full task history:
https://github.com/Trapa-Eureka/product_agent
