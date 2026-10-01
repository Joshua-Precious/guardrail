# Guardrail

### A human-in-the-loop AI support agent built with Cequre

Guardrail is a working demo of one security guarantee:

> **An AI agent can propose a risky action. It cannot approve or execute it.**

An AI support agent reads customer and order data, replies to customers, and proposes
refunds. Every proposal lands in a `pending` queue. A human administrator approves or
rejects it in Cequre's admin console. Only then does a separate executor worker perform
the action — driven by realtime events, not polling.

The boundary is not enforced inside the agent. It is a few lines of Cequre **schema access
rules**, so there is no code path where the model's output becomes authorization. When the
agent tries to approve its own refund, the backend answers `403`:

```text
$ bun run acceptance --live
  -> get_order
  -> propose_refund
[3] Agent attempts to approve its own proposal
    HTTP 403 Forbidden — blocked by the schema access rules
...
PASS (live model) — the agent could propose the action. Only a human could approve it.
```

Runs end to end, **40 tests, 0 failures**, verified with a live model. It is a demo, not
production software — the refund is simulated. See [Not in scope](#not-in-scope).

**Contents** · [What you can build](#what-you-can-build-with-it) ·
[Tech stack](#tech-stack) · [Quickstart](#quickstart) · [How it works](#how-it-works) ·
[The boundary](#the-security-boundary) · [Architecture](#architecture) ·
[Repository map](#repository-map) · [Model configuration](#the-agents-model) ·
[Tests](#test-suite) · [Status](#project-status)

---

## What you can build with it

Guardrail is a reference implementation of a **propose → approve → execute** loop. The
domain (customer support, refunds) is deliberately boring; the pattern is the point. Swap
"refund" for any action that is too risky to hand to a model directly.

| If you are building… | Guardrail gives you |
| --- | --- |
| An AI support agent that can issue refunds or credits | An agent that is only *capable* of creating `pending` proposals — it has no update permission at all |
| An agent that edits billing, CRM, infra, or account records | The same split: the model proposes, a human authorizes, a worker executes |
| A human approval queue without building an admin UI | Cequre's admin console, scoped to the `admins` collection, with approve/reject on each proposal |
| A realtime execution worker | An SSE subscription that fires the moment a human approves — milliseconds, no polling |
| An audit trail for everything the agent asked for | Each proposal stores its type, target, the model's reasoning, its status, and the executor's result |
| A security review of an agent boundary | An adversarial suite that attacks the boundary: smuggled statuses, replays, forged tokens, privilege escalation |

**The pattern, generalized.** Four actors, four permissions, no overlap:

```text
agent      →  create a proposal            (never approve, never execute)
human      →  approve or reject it          (Cequre admin console)
executor   →  perform it, exactly once      (separate worker, separate credentials)
backend    →  enforce all of the above      (schema access rules, not agent code)
```

**Honest limits.** There is no approval UI beyond Cequre's admin console, no notifications,
no multi-step approvals, and one action vocabulary shared by every proposal type. It is
small on purpose so the security idea stays legible.

---

## Tech stack

| Layer | Choice | Why it matters here |
| --- | --- | --- |
| **Backend, API, auth, authorization, admin UI, realtime** | **Cequre** (CLI 1.0.3) | Collections, fields, roles and access rules are declared in `.cequre` DSL and compiled into the database schema, REST API, GraphQL API and authorization layer. That compiled layer *is* the security boundary of this project. |
| **Database** | PostgreSQL via Cequre's `PostgresAdapter` | Schema is source-of-truth: `cequre db:sync` applies it, there are no migration files. |
| **LLM** | Any tool-calling model — provider-neutral | Ollama (cloud or local), any OpenAI-compatible endpoint, or Anthropic. `scripted` is the deterministic default for tests. |
| **Runtime** | Bun 1.4 | Runs the server and both workers, and is the test runner. |
| **Language** | TypeScript 7 | No build step during development; `bun run typecheck` type-checks with `tsc --noEmit`. |
| **APIs & transports** | REST (JWT), GraphQL, SSE, MCP | REST for the agent and executor; GraphQL generated from the same schema (enabled in `config.cequre`); SSE for realtime approvals; MCP for AI-assisted development of the backend itself. |
| **Security plugins** | `defaultSecurity()`, `defaultMonitoring()` | JWT access/refresh tokens, rate limiting, health checks. |

Everything here is runnable: no part of the authorization layer is mocked in the tests or
in the acceptance run.

---

## Quickstart

**Prerequisites**

- **Bun** 1.4+ — `bun --version`
- **PostgreSQL** reachable at `DATABASE_URL`
- **The Cequre CLI** on your `PATH` (built against `cequre` 1.0.3) — `cequre --version`.
  Every `cequre …` script in `package.json` depends on it.

```bash
git clone https://github.com/Joshua-Precious/guardrail.git
cd guardrail
bun install

cp .env.example .env
cequre key:generate --save   # writes CEQURE_ENCRYPTION_KEY into .env
cequre doctor                # pre-flight: DSL, schema, DB, keys, ports

cequre db:sync               # apply the schema (cequre dev syncs automatically)
bun run seed                 # admin + agent + executor accounts, customer, order #1024
```

**See the guarantee for yourself** — propose, get refused, get approved, get executed:

```bash
bun run acceptance           # deterministic agent (scripted provider)
bun run acceptance --live    # the real model picks its own tools, then gets 403
bun test                     # 40 tests covering the authorization matrix
```

**Run the pieces individually:**

```bash
cequre dev                   # watch the DSL + hot-reload the server (:3000)

bun run agent "I was charged twice for order #1024. Please refund me." --self-approve
bun run executor             # realtime: reacts to approvals over SSE
bun run executor --poll      # polling fallback
bun run executor --once      # process the current batch and exit

bun run model:check          # verify the agent's model provider configuration
bun run mcp                  # Cequre's MCP server (stdio) for AI coding clients
```

A human approves at **`http://localhost:3000/admin`** (log in with `ADMIN_EMAIL` /
`ADMIN_PASSWORD`), or by calling `POST /api/agent_actions/:id/approve`.

---

## How it works

A customer sends a support request:

> "I was charged twice for order #1024. Can I get a refund?"

```text
AI reasoning
     ↓
Proposed action          ← the agent stops here
     ↓
Human approval           ← a person decides
     ↓
Execution                ← a separate worker performs it
```

Instead of:

```text
AI reasoning
     ↓
Immediate execution
```

### The walkthrough

**1. Customer requests a refund**

```text
"I was charged twice for order #1024."
```

**2. Agent investigates** (safe tools — these run immediately)

```text
get_order        →  Order #1024 · ₦45,000 · paid
list_orders      →  one matching order
```

**3. Agent proposes a refund** (risky tool — creates a proposal, nothing more)

```text
type: refund   status: pending   reasoning: "possible duplicate charge"
```

**4. Agent attempts to approve its own proposal**

```text
PATCH /api/agent_actions/:id   { "status": "approved" }
```

```text
403 Forbidden
```

**5. A human approves it** — in the admin console, or via the API

```text
pending → approved
```

**6. Executor performs it and records the result**

```text
approved → executed   result: "Refund successfully processed."
```

The full state machine:

```text
pending → approved → executed
pending → rejected
approved → failed
```

---

## The security boundary

The `agent_actions` collection is the heart of the project. Its permissions:

```text
                 CREATE    UPDATE
Agent               ✓         ✗
Admin               ✗         ✓
Executor            ✗         ✓
```

And in the schema itself — this is the entire enforcement mechanism:

```cequre
collection agent_actions {
  realtime: { sse: true }   // broadcast status changes to the executor

  fields: {
    type: select("refund", "close_ticket", "escalate");
    status: select("pending", "approved", "rejected", "executed", "failed")
      @default("pending");
    customer: relationship("customers");
    order: relationship("orders") @optional;
    reasoning: text;
    result: text @optional;
  }

  access: {
    read:   user.role == "agent" || user.role == "executor" || user.role == "admin"
         || user.role == "super" || user.role == "editor";
    create: user.role == "agent";
    update: user.role == "admin" || user.role == "super"
         || user.role == "editor" || user.role == "executor";
    delete: user.role == "admin" || user.role == "super";
  }
}
```

The `update` rule deliberately excludes `agent`. That single omission is the guarantee.

**Why this is stronger than a check in the agent.** Giving an agent the ability to *decide*
an action should happen is not the same as giving it permission to *authorize or execute*
it. When that check lives in agent code, every new tool is a new chance to forget it, and
a persuasive prompt is a new chance to talk around it. Here there is one declarative rule,
compiled into the authorization layer, that every request goes through — including requests
the agent never intended to make.

**Layered on top, all server-side** (`cequre/routes/index.ts`):

- `beforeCreate` forces `status = "pending"` and deletes any smuggled `status`/`result`.
- `beforeUpdate` enforces the state machine, strips non-`status`/`result` fields from
  executor writes, and refuses to re-run a terminal `executed`/`failed` action.
- `/approve`, `/reject`, `/execute` are thin aliases that re-enter the same pipeline with
  the caller's own credentials — an agent calling `/approve` still gets `403`.

**Realtime inherits the same rules.** The executor doesn't poll; it subscribes to
`GET /api/sse?channel=agent_actions`, and the subscription is authorized exactly like an
HTTP request. Connect without a token and the server answers with no channels at all:

```text
# anonymous subscriber
event: connected
data: {"channels":[],"authenticated":false}

# executor subscriber (valid token)
event: connected
data: {"channels":["agent_actions"],"authenticated":true}

event: agent_actions:updated
data: {"id":"01M3VH4NHM0RYC0VCPAC13XEQZ","status":"approved", ...}
```

So the stream is not a side door around the access rules — the same rule engine decides who
may listen to what.

---

## Architecture

```text
                         ┌─────────────────────┐
                         │      Customer       │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │      AI Agent       │
                         │                     │
                         │ LLM + Bun           │
                         │                     │
                         │ Read data           │
                         │ Reason              │
                         │ Propose actions     │
                         └──────────┬──────────┘
                                    │
                                 REST + JWT
                                    │
                                    ▼
                    ┌─────────────────────────────┐
                    │           Cequre            │
                    │                             │
                    │  Collections                │
                    │  Authentication             │
                    │  Access rules               │
                    │  Admin console              │
                    │  Realtime (SSE)             │
                    └───────────┬─────────────────┘
                                │
                    ┌───────────┴────────────┐
                    │                        │
                    ▼                        ▼
          ┌─────────────────┐      ┌──────────────────┐
          │  Admin Console  │      │ Executor Worker  │
          │                 │      │                  │
          │ Approve/Reject  │      │ Execute approved │
          │ actions         │      │ actions          │
          └─────────────────┘      └──────────────────┘
```

### Main components

**Cequre** — the backend: data collections, authentication, role-based access,
authorization, admin console, REST API and realtime. The access rules are the primary
security mechanism demonstrated by this project.

**AI agent** — a Bun worker with a provider-neutral model layer. It has two kinds of tools:

```text
Safe tools  (run immediately)   get_customer · get_order · list_orders · reply_to_customer
Risky tools (propose only)      propose_refund · propose_close_ticket · propose_escalation
```

Risky tools never perform their action; they only create `pending` proposals.

**Admin** — a human who reviews proposals in Cequre's admin console and approves or rejects
them.

**Executor** — a separate worker that performs approved actions and records the result. It
makes no approval decisions.

---

## Repository map

| Path | What lives there |
| --- | --- |
| `cequre/collections/*.cequre` | The schema: `agent_actions`, `customers`, `orders`, `conversations`, `messages`, `users`, `admins` — fields, relationships and access rules |
| `cequre/config.cequre` | Framework config: security, JWT, monitoring, admin console |
| `cequre/index.ts` | Composition root — creates the Cequre app with the routes module and starts it |
| `cequre/routes/index.ts` | Business logic: `/health`, the state-machine hooks, the approve/reject/execute endpoints |
| `agent/` | The AI worker: `model.ts` (provider-neutral clients), `tools.ts`, `prompts.ts`, `cequre.ts` (REST client), `index.ts` (CLI) |
| `executor/` | The executor worker: `sse.ts` (realtime subscription), `index.ts` (`--poll`, `--once`) |
| `lib/app.ts` | In-process composition root used by scripts and tests (`app.fetch()` — the real pipeline) |
| `lib/server.ts` | `startHttpServer()` for tests and workers that need real sockets |
| `scripts/` | `seed.ts`, `acceptance.ts`, `model-check.ts` |
| `tests/` | The 36-test suite — authorization, security, realtime, MCP, model, wiring |
| `cequre/_generated/` | Compiled output. Never edit — regenerate with `cequre generate` |

---

## The agent's model

The model layer is provider-neutral: the agent loop only knows a `ModelClient` interface,
so the provider is configuration, not code (see `agent/model.ts`). Verify it before a demo:

```bash
bun run model:check       # prints the resolved config and makes one tiny call
```

**Ollama Cloud (verified working, no local server needed).** With an Ollama API key, point
the agent straight at the hosted OpenAI-compatible endpoint — the default in `.env`:

```bash
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://ollama.com/v1
AI_MODEL=gpt-oss:120b     # any id from: curl -H "Authorization: Bearer $KEY" https://ollama.com/v1/models
AI_API_KEY=<your ollama.com API key>
```

**Local Ollama (for an offline demo).** No API key, but the server must be running:

```bash
ollama serve
ollama pull gpt-oss:20b   # or reuse a model you already have

AI_PROVIDER=openai-compatible
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=gpt-oss:20b
AI_API_KEY=ollama         # the value is ignored, but the client requires one
```

`AI_PROVIDER` also accepts `scripted` (deterministic, no network — used by the test suite
and by `bun run acceptance` without `--live`) or `anthropic`
(`AI_BASE_URL=https://api.anthropic.com`). Any OpenAI-compatible endpoint works the same
way (OpenAI, OpenRouter, Groq, vLLM, ...); the model just needs to support tool calling.

### MCP

`bun run mcp` starts Cequre's native MCP server over stdio (`bun run mcp:http` serves it
over HTTP/SSE on port 3737). Point an MCP client at it and an assistant gets schema-aware
access to the backend: `cequre_schema`, `cequre_security`, `cequre_routes`,
`cequre_database`, `cequre_test`, and friends. These are *development* tools — the runtime
tools (`get_customer`, `propose_refund`, ...) stay with the agent worker, and every data
request still goes through the same access rules.

Administrators can also act through intent-revealing endpoints instead of a raw PATCH:
`POST /api/agent_actions/:id/approve`, `/reject`, and `/execute`.

---

## Test suite

A focused suite that exercises the security boundary through the real request pipeline —
the authorization layer is never mocked.

| File | What it covers |
|---|---|
| `tests/authorization.test.ts` | Full role matrix: agent→create (201), agent→approve (403), admin→approve (200), executor→execute (200), semantic endpoints |
| `tests/security.test.ts` | Adversarial cases: smuggled status on create, token forgery, replay attacks, executor field stripping, malformed payloads |
| `tests/model.test.ts` | Provider-neutral live path: stub OpenAI-compatible server, agent loop drives the real Cequre backend |
| `tests/sse.test.ts` | Realtime executor: approval event delivered over SSE, executor reacts without polling |
| `tests/mcp.test.ts` | Cequre MCP server: JSON-RPC handshake, `tools/list` response |
| `tests/app.test.ts` | Health check, basic server wiring |

```bash
bun test          # 40 pass, 0 fail
bun run check     # typecheck + tests
```

---

## Project status

The core guarantee is fully implemented and tested:

> **The agent can propose a risky action, but only an authorized human can approve it.**

- ✅ Schema, access rules, and state-machine hooks
- ✅ Agent worker (scripted, Anthropic, and OpenAI-compatible providers)
- ✅ Executor worker (SSE realtime mode + polling fallback)
- ✅ Seed data and end-to-end acceptance script (`bun run acceptance`)
- ✅ Live-model acceptance run: the model picks its own tools, then gets 403 (`bun run acceptance --live`)
- ✅ MCP server (`bun run mcp`)
- ✅ Full test suite covering the security boundary

### Not in scope

- The refund is simulated; no payment provider is called.
- Field-level write restrictions are enforced in the `agent_actions` hooks rather than the
  DSL: the CLI version used here compiles the collection `access` block but drops per-field
  `writeRoles`, so the state machine is guarded in `cequre/routes/index.ts`.

---

## License

MIT — see [LICENSE](LICENSE).
