# Guardrail

### A human-in-the-loop AI support agent built with Cequre

Guardrail is a small AI customer-support system designed to demonstrate a simple but important security principle:

> **An AI agent can propose a risky action without having permission to approve or execute that action.**

The project uses **Cequre as the backend and authorization layer**, with an AI agent powered by Claude and small worker scripts for orchestration and execution.

The agent can read customer and order information, respond to customers, and propose actions such as refunds or ticket closures.

However, once the agent proposes a risky action, that action enters a pending queue. A human administrator must approve it before an executor can perform it.

The important part is that this boundary is enforced by **Cequre's schema access rules**, rather than relying on authorization checks inside the AI agent.

---

## The problem

AI agents are increasingly capable of taking actions on behalf of users.

An agent might be able to:

- Look up an order
- Decide that a refund is appropriate
- Close a support ticket
- Escalate a customer issue
- Update application data

But giving an agent the ability to *decide* that an action should happen is different from giving it permission to *authorize and execute* that action.

For sensitive operations, we want a workflow like:

```text
AI reasoning
     ↓
Proposed action
     ↓
Human approval
     ↓
Execution
```

Rather than:

```text
AI reasoning
     ↓
Immediate execution
```

Guardrail demonstrates this distinction.

---

## How it works

A customer sends a support request.

For example:

> "I was charged twice for my order. Can I get a refund?"

The AI agent:

1. Reads the customer's information.
2. Looks up the relevant order.
3. Determines that a refund may be appropriate.
4. Creates a refund request in `agent_actions`.
5. Tells the customer that the request has been submitted for review.

The refund is **not executed**.

The action remains:

```text
pending
```

A human administrator then reviews the proposed action.

If approved:

```text
pending → approved
```

An executor worker detects the approved action and performs it:

```text
approved → executed
```

If rejected:

```text
pending → rejected
```

---

## The important security boundary

The `agent_actions` collection is the core of the project.

Conceptually, its permissions look like this:

```text
                 CREATE    UPDATE
Agent               ✓         ✗
Admin               ✗         ✓
Executor            ✗         ✓
```

The agent is allowed to create a proposed action.

It is not allowed to change that action's status.

Therefore, if the agent attempts:

```text
status = "approved"
```

the backend rejects the request.

The authorization decision is made by Cequre.

The agent does not get to decide whether it has permission.

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
                              REST / MCP
                                    │
                                    ▼
                    ┌─────────────────────────────┐
                    │           Cequre            │
                    │                             │
                    │  Collections                │
                    │  Authentication             │
                    │  Access rules               │
                    │  Admin console               │
                    │  Realtime                   │
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

---

## Main components

### Cequre

Cequre acts as the application's backend.

It provides the project's:

- Data collections
- Authentication
- Role-based access
- Authorization
- Admin interface
- API
- Realtime capabilities

The access rules are the primary security mechanism demonstrated by the project.

### AI Agent

A small Bun-based worker powered by a pluggable LLM (any tool-calling provider).

The agent has two categories of tools.

#### Safe tools

These can execute immediately.

```text
get_customer
get_order
list_orders
reply_to_customer
```

#### Risky tools

These only create proposals.

```text
propose_refund
propose_close_ticket
propose_escalation
```

Risky tools never directly execute their corresponding action.

### Admin

A human administrator reviews proposed actions through Cequre's admin console.

The administrator can approve or reject an action.

### Executor

The executor is a small worker responsible for performing approved actions.

It does not make approval decisions.

Its job is simply:

```text
approved action
       ↓
execute
       ↓
record result
```

---

## Example workflow

### 1. Customer requests a refund

```text
Customer:
"I was charged twice for order #1024."
```

### 2. Agent investigates

```text
Order #1024
Amount: ₦45,000
Status: Paid
```

### 3. Agent proposes a refund

```text
Type: refund
Status: pending
Order: #1024
Reasoning: Possible duplicate charge
```

### 4. Agent attempts to approve

```text
PATCH /agent_actions/:id
status = approved
```

Cequre responds:

```text
403 Forbidden
```

### 5. Human approves

The administrator changes:

```text
pending → approved
```

### 6. Executor runs the action

```text
approved → executed
```

The result is stored on the action.

---

## Running the backend locally

```bash
bun install
cequre db:sync            # apply the schema (cequre dev syncs automatically)
cequre dev                # optional: watch the DSL + hot-reload the server

bun run seed              # admin + agent + executor accounts, customer, order #1024
bun run acceptance        # propose -> 403 -> approve -> execute, end to end
bun test                  # the authorization matrix
bun run model:check       # verify the agent's model provider configuration
```

The two workers are plain Bun processes:

```bash
bun run agent "I was charged twice for order #1024. Please refund me." --self-approve
bun run executor          # realtime: reacts to approvals over SSE
bun run executor --poll   # polling fallback
bun run executor --once   # process the current batch and exit
```

### The agent's model

The model layer is provider-neutral. Configure it in `.env`; the default is
Ollama, so the agent runs entirely locally:

```bash
ollama serve
ollama pull llama3.2      # a small local model, or reuse one you already have

AI_PROVIDER=openai-compatible
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=llama3.2         # any name from `ollama list`
AI_API_KEY=ollama         # Ollama ignores the value, but the client requires one
```

`AI_PROVIDER` also accepts `scripted` (deterministic, no network — used by the
test suite) or `anthropic`. Any OpenAI-compatible endpoint works the same way
(OpenAI, OpenRouter, Groq, vLLM, ...). Any tool-calling model works; small models
with reliable tool calls include `llama3.2`, `llama3.1`, and `qwen2.5`.

### MCP

`bun run mcp` starts Cequre's native MCP server over stdio (`bun run mcp:http`
serves it over HTTP/SSE on port 3737). Point an MCP client at it and an assistant
gets schema-aware access to the backend: `cequre_schema`, `cequre_security`,
`cequre_routes`, `cequre_database`, `cequre_test`, and friends. Note these are
*development* tools — the runtime tools (`get_customer`, `propose_refund`, ...)
stay with the agent worker, and every data request still goes through the same
access rules.

Administrators can also act through intent-revealing endpoints instead of a raw
PATCH: `POST /api/agent_actions/:id/approve`, `/reject`, and `/execute`. They are
thin aliases that re-enter the same pipeline, so the schema access rules and the
transition hooks still decide the outcome — an agent calling `/approve` is still
rejected with `403`.

---

## Why this project exists

Guardrail is primarily a demonstration project.

It explores how an AI application's permissions can be enforced at the backend layer instead of relying entirely on the agent implementation.

The project demonstrates:

- Human-in-the-loop AI workflows
- Role-based authorization
- Separation between proposing and executing actions
- Schema-level access control
- AI agents interacting with structured backend data
- Backend-enforced security boundaries

It is intentionally small so that the core idea remains easy to understand.

---

## Technology

- **Cequre** — backend, database, authentication and authorization
- **Bun** — agent and worker runtime
- **LLM provider** — any tool-calling model (provider-neutral)
- **TypeScript** — application code
- **REST / MCP** — agent-to-backend communication, depending on the implementation

---

## Test suite

The project ships with a focused test suite that exercises the security boundary directly through the real request pipeline — no mocks for the authorization layer.

| File | What it covers |
|---|---|
| `tests/authorization.test.ts` | Full role matrix: agent→create (201), agent→approve (403), admin→approve (200), executor→execute (200), semantic endpoints |
| `tests/security.test.ts` | Adversarial cases: smuggled status on create, token forgery, replay attacks, executor field stripping |
| `tests/model.test.ts` | Provider-neutral live path: stub OpenAI-compatible server, agent loop drives real Cequre backend |
| `tests/sse.test.ts` | Realtime executor: approval event delivered over SSE, executor reacts without polling |
| `tests/mcp.test.ts` | Cequre MCP server: JSON-RPC handshake, `tools/list` response |
| `tests/app.test.ts` | Health check, basic server wiring |

Run them all with:

```bash
bun test
```

---

## Project status

The core guarantee is fully implemented and tested:

> **The agent can propose a risky action, but only an authorized human can approve it.**

- ✅ Schema, access rules, and state-machine hooks
- ✅ Agent worker (scripted, Anthropic, and OpenAI-compatible providers)
- ✅ Executor worker (SSE realtime mode + polling fallback)
- ✅ Seed data and end-to-end acceptance script
- ✅ MCP server (`bun run mcp`)
- ✅ Full test suite covering the security boundary