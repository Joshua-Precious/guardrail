# Guardrail — Runbook

How to run and test the project yourself from scratch.

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.4
- [Cequre CLI](https://cequre.dev) installed globally
- PostgreSQL running locally (or a connection string to a hosted database)

---

## 1. Install dependencies

```bash
bun install
```

---

## 2. Set up your environment

Create a `.env` file in the project root:

```env
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/guardrail

JWT_SECRET=any-random-string-here

API_BASE_URL=http://localhost

ADMIN_EMAIL=admin@guardrail.dev
ADMIN_PASSWORD=Passw0rd!123
AGENT_EMAIL=agent@guardrail.dev
AGENT_PASSWORD=Passw0rd!123
EXECUTOR_EMAIL=executor@guardrail.dev
EXECUTOR_PASSWORD=Passw0rd!123

POLL_INTERVAL_MS=3000

# Model provider — set to "scripted" to run without an API key
AI_PROVIDER=scripted
```

> Replace `DATABASE_URL` with your actual Postgres credentials.
> The database (`guardrail`) must already exist — Cequre will create the tables.

---

## 3. Start the backend

```bash
cequre dev
```

This will:
- Compile the `.cequre` schema files
- Sync the database schema
- Start the server on `http://localhost:3000`
- Hot-reload on schema changes

Leave this running in a terminal.

---

## 4. Seed demo data

In a second terminal:

```bash
bun run seed
```

This creates:
- `admin@guardrail.dev` — human approver
- `agent@guardrail.dev` — the AI agent identity
- `executor@guardrail.dev` — the executor worker
- Customer: **John Doe**
- Order: **#1024**, ₦45,000, status: `paid`
- An open conversation and a customer message

The script is idempotent — safe to run multiple times.

---

## 5. Run the test suite

```bash
bun test
```

Expected output:

```
 36 pass
 0 fail
Ran 36 tests across 6 files.
```

What the tests cover:
- **authorization** — full role matrix (agent→create ✅, agent→approve ❌ 403, admin→approve ✅, executor→execute ✅)
- **security** — token forgery, replay attacks, smuggled status fields
- **model** — agent loop against a stub OpenAI-compatible server
- **sse** — realtime executor reacts to approval events without polling
- **mcp** — Cequre MCP server JSON-RPC handshake

---

## 6. Run the end-to-end acceptance script

```bash
bun run acceptance
```

This proves the full flow in one command:

```
[1] Agent reads the customer's order
[2] Agent proposes a refund           → pending
[3] Agent attempts to self-approve    → HTTP 403 Forbidden
[4] Human administrator approves it   → pending → approved
[5] Executor performs the action      → approved → executed
[6] Verify the final state            → status=executed
```

---

## 7. Run the agent manually

```bash
bun run agent "I was charged twice for order #1024. Please refund me."
```

With `--self-approve` to explicitly show the 403:

```bash
bun run agent "I was charged twice for order #1024. Please refund me." --self-approve
```

Other action types:

```bash
bun run agent "Please close my ticket." --action close_ticket
bun run agent "I need to speak to a manager." --action escalate
```

---

## 8. Run the executor

In a separate terminal, start the executor (SSE realtime mode):

```bash
bun run executor
```

It connects and waits. The moment an admin approves an action through `/__admin`, the executor picks it up immediately over SSE.

Fallback options:

```bash
bun run executor --poll    # poll every 3 seconds instead of SSE
bun run executor --once    # process the current approved batch and exit
```

---

## 9. Use a real AI model (optional)

To swap in a real LLM instead of the deterministic scripted provider, update `.env`:

**Ollama (local, free):**

```env
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=llama3.2
AI_API_KEY=ollama
```

```bash
ollama serve
ollama pull llama3.2
```

**Anthropic Claude:**

```env
AI_PROVIDER=anthropic
AI_BASE_URL=https://api.anthropic.com
AI_MODEL=claude-3-5-haiku-20241022
AI_API_KEY=sk-ant-...
```

**OpenRouter / Groq / any OpenAI-compatible endpoint:**

```env
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=meta-llama/llama-3.2-3b-instruct
AI_API_KEY=sk-or-...
```

Then verify and run:

```bash
bun run model:check
bun run agent "I was charged twice for order #1024. Please refund me."
```

---

## 10. Admin console

With `cequre dev` running, open:

```
http://localhost:3000/__admin
```

Log in with `admin@guardrail.dev / Passw0rd!123`.

Browse collections, view pending `agent_actions`, and manually approve or reject proposals.

---

## 11. MCP server (optional)

```bash
bun run mcp        # stdio transport (Claude Desktop, Cursor, etc.)
bun run mcp:http   # HTTP/SSE transport on port 3737
```

Point any MCP client at it for schema-aware access to the backend.

---

## Quick reference

| Command | What it does |
|---|---|
| `cequre dev` | Start the backend server |
| `bun run seed` | Create demo accounts and data |
| `bun test` | Run the full test suite (36 tests) |
| `bun run acceptance` | End-to-end flow in one command |
| `bun run agent "..."` | Run the agent worker |
| `bun run executor` | Start the executor (SSE mode) |
| `bun run model:check` | Verify AI provider config |
| `bun run mcp` | Start the MCP server |
