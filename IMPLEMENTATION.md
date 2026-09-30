# Guardrail — Implementation Plan

This document describes the implementation plan for the Guardrail demo.

The goal is to build the smallest possible system that proves the project's core idea before adding AI functionality or unnecessary infrastructure.

---

# 1. Core objective

Build an AI customer-support agent that can propose risky actions but cannot approve or execute those actions itself.

The core flow is:

```text
Customer request
      ↓
AI agent
      ↓
Proposed action
      ↓
Cequre
      ↓
Human approval
      ↓
Executor
      ↓
Action executed
```

The most important test is:

```text
Agent creates action       → allowed
Agent approves action      → rejected
Admin approves action      → allowed
Executor executes action  → allowed
```

If this works, the core demo works.

---

# 2. Implementation principles

### Principle 1 — Prove authorization first

Do not start with Claude.

The first milestone is proving that Cequre can enforce:

```text
agent → create
admin → approve
executor → execute
```

using backend access rules.

### Principle 2 — Keep the agent stateless where possible

The agent should primarily orchestrate:

```text
read → reason → call tool → respond
```

Application state belongs in Cequre.

### Principle 3 — Risky tools only propose

The following tools must never directly execute their action:

```text
propose_refund
propose_close_ticket
propose_escalation
```

They create `agent_actions`.

### Principle 4 — The executor does not decide

The executor should only act on an already-approved action.

It must not determine whether an action deserves approval.

---

# 3. Phase 0 — Environment spike

**Estimated time: 1 hour**

Before writing application code, verify the Cequre environment.

## Tasks

- [ ] Install Cequre CLI
- [ ] Run `cequre init`
- [ ] Run `cequre dev`
- [ ] Verify `/__admin`
- [ ] Verify `/api/docs`
- [ ] Verify `/graphql`
- [ ] Confirm authentication flow
- [ ] Confirm user creation
- [ ] Confirm role configuration
- [ ] Confirm collection access rules
- [ ] Confirm admin console record editing
- [ ] Determine login endpoint
- [ ] Determine JWT authentication format
- [ ] Verify MCP availability
- [ ] Verify realtime/SSE support

Do not proceed if basic authentication and authorization cannot be established.

---

# 4. Phase 1 — Project structure

Create a simple structure:

```text
guardrail/
├── .cequre/
│   └── ...
│
├── agent/
│   ├── index.ts
│   ├── cequre.ts
│   ├── tools.ts
│   └── prompts.ts
│
├── executor/
│   ├── index.ts
│   └── cequre.ts
│
├── scripts/
│   └── seed.ts
│
├── README.md
├── IMPLEMENTATION.md
└── package.json
```

The Cequre schema/configuration remains the source of truth for the backend.

---

# 5. Phase 2 — Data model

**Estimated time: 1–2 hours**

Create the minimum required collections.

## Users

```text
users
```

Fields:

```text
id
name
email
role
```

Roles:

```text
admin
agent
executor
user
```

---

## Customers

```text
customers
```

Fields:

```text
id
name
email
```

---

## Orders

```text
orders
```

Fields:

```text
id
customer
amount
status
```

Possible statuses:

```text
pending
paid
refunded
cancelled
```

Use the numeric field type supported by the current Cequre documentation for `amount`.

---

## Conversations

```text
conversations
```

Fields:

```text
id
customer
status
```

---

## Messages

```text
messages
```

Fields:

```text
id
conversation
sender
content
```

The sender can represent:

```text
user
agent
```

---

## Agent Actions

This is the most important collection.

```text
agent_actions
```

Fields:

```text
id
type
status
customer
order
reasoning
result
```

Types:

```text
refund
close_ticket
escalate
```

Statuses:

```text
pending
approved
rejected
executed
failed
```

---

# 6. Phase 3 — Access rules

**Estimated time: 1 hour**

Implement the authorization model.

The exact syntax should follow the current Cequre documentation.

Conceptually:

## `agent_actions`

```text
CREATE
agent

UPDATE
admin OR executor

DELETE
admin
```

The agent must not have update permission.

This is intentional.

---

# 7. Phase 4 — Authorization tests

**Estimated time: 30–60 minutes**

Before building the AI, test the authorization manually.

## Test A — Agent creates action

Authenticate as agent.

Create:

```text
{
  "type": "refund",
  "status": "pending"
}
```

Expected:

```text
201 Created
```

---

## Test B — Agent tries to approve

Authenticate as agent.

Attempt:

```text
status = approved
```

Expected:

```text
403 Forbidden
```

This is the most important test in the entire project.

---

## Test C — Admin approves

Authenticate as admin.

Update:

```text
pending → approved
```

Expected:

```text
200 OK
```

---

## Test D — Executor executes

Authenticate as executor.

Update the approved action to:

```text
executed
```

Expected:

```text
200 OK
```

---

# 8. Phase 5 — Seed data

**Estimated time: 30 minutes**

Create realistic demo data.

Seed approximately:

```text
5–10 customers
10–20 orders
3–5 conversations
```

Create at least one useful scenario:

```text
Customer:
John Doe

Order:
#1024

Amount:
₦45,000

Status:
paid
```

This gives the AI something real to inspect.

---

# 9. Phase 6 — Agent worker

**Estimated time: 2–3 hours**

Create a small Bun/TypeScript worker.

Responsibilities:

1. Authenticate as the agent.
2. Receive a customer message.
3. Load conversation history.
4. Query customer/order information.
5. Send context to Claude.
6. Expose safe and risky tools.
7. Store the agent response.
8. Store risky actions as pending proposals.

---

# 10. Agent tools

## Safe tools

### `get_customer`

Returns customer information.

```text
Input:
customer_id
```

### `get_order`

Returns order information.

```text
Input:
order_id
```

### `list_orders`

Returns orders associated with a customer.

```text
Input:
customer_id
```

### `reply_to_customer`

Creates an agent message.

```text
Input:
conversation_id
content
```

---

## Risky tools

These tools never perform the actual action.

### `propose_refund`

Creates:

```text
agent_action
```

with:

```text
type = refund
status = pending
```

### `propose_close_ticket`

Creates:

```text
type = close_ticket
status = pending
```

### `propose_escalation`

Creates:

```text
type = escalate
status = pending
```

Each action should contain useful reasoning explaining why the agent proposed it.

---

# 11. Agent behavior

The agent should follow this basic policy:

```text
If request is informational:
    answer immediately

If request requires safe data access:
    use safe tools

If request requires risky action:
    create a pending action

Never approve or execute a risky action
```

Example:

```text
Customer:
"I was charged twice. Refund the duplicate payment."

Agent:
1. get_customer()
2. get_order()
3. determine refund is appropriate
4. propose_refund()
5. tell customer approval is required
```

---

# 12. Phase 7 — Executor worker

**Estimated time: 1–2 hours**

The executor is intentionally simple.

It watches for approved actions.

Flow:

```text
pending
   ↓
human approves
   ↓
approved
   ↓
executor detects action
   ↓
execute
   ↓
executed
```

For the demo, actual payment-provider integration is unnecessary.

The executor can simulate the external operation.

Example:

```text
Refunding order #1024...

Refund successful.
```

Then update:

```text
status = executed
result = "Refund successfully processed."
```

---

# 13. Phase 8 — Realtime

**Optional**

If Cequre's realtime functionality works as expected, use it for the executor.

Potential flow:

```text
Cequre
   ↓
SSE
   ↓
Executor
   ↓
approved action detected
```

Verify:

- Realtime endpoint
- Authentication
- Subscription syntax
- Event payload
- Update event behavior

Do not let realtime block the MVP.

Polling can be used temporarily during development if necessary.

---

# 14. Phase 9 — MCP

**Optional stretch goal**

After the REST-based implementation works, investigate Cequre's MCP server.

Potential architecture:

```text
Claude
   ↓
MCP
   ↓
Cequre
   ↓
Access rules
```

The goal is to see whether Claude can discover and use Cequre capabilities through MCP without manually implementing every REST tool.

This is a secondary demo.

The core project must work without it.

---

# 15. End-to-end acceptance test

The project is considered complete when this scenario works from beginning to end.

## Customer

```text
"I was charged twice for my order. Please refund me."
```

## Agent

Reads:

```text
customer
order
transaction information
```

Creates:

```text
agent_action
```

with:

```text
type = refund
status = pending
```

Responds:

```text
"I've submitted your refund request for human review."
```

## Agent attempts approval

```text
status = approved
```

Result:

```text
403 Forbidden
```

## Admin

Approves:

```text
pending → approved
```

## Executor

Executes:

```text
approved → executed
```

Writes:

```text
result = successful
```

---

# 16. Demo recording plan

Target length:

**60–90 seconds**

### Scene 1 — Introduction

Show the project.

Text:

> "I built an AI support agent that can't approve its own refunds."

### Scene 2 — Schema

Show the relevant access rules.

Highlight:

```text
agent → create
admin | executor → update
```

### Scene 3 — Customer request

Show:

```text
I was charged twice. Refund me.
```

### Scene 4 — Agent reasoning

Show the order being retrieved.

### Scene 5 — Action created

Show:

```text
refund
pending
```

### Scene 6 — Agent attempts approval

Show:

```text
403 Forbidden
```

Pause here.

### Scene 7 — Human approval

Show admin changing:

```text
pending → approved
```

### Scene 8 — Execution

Show:

```text
approved → executed
```

### Scene 9 — Final message

Show:

> **The agent can propose the action. The backend decides whether it is allowed to approve it.**

---

# 17. Metrics to record

Before publishing, record:

```text
Time to build
Number of collections
Number of schema lines
Number of access rules
Number of agent tools
Number of application files
Number of dependencies
```

Also record any problems encountered.

An honest technical limitation or unexpected issue can make the content more credible.

---

# 18. Definition of Done

The MVP is complete when:

- [ ] Cequre runs locally
- [ ] Authentication works
- [ ] Roles work
- [ ] `agent_actions` exists
- [ ] Agent can create an action
- [ ] Agent cannot approve an action
- [ ] Cequre returns `403`
- [ ] Admin can approve
- [ ] Executor can execute
- [ ] Customer/order data exists
- [ ] Claude can interact with the backend
- [ ] Agent can propose a refund
- [ ] End-to-end flow works
- [ ] Demo can be reproduced from a clean environment

Optional:

- [ ] Realtime executor
- [ ] MCP integration
- [ ] Additional action types
- [ ] Better admin experience
- [ ] Production deployment

---

# 19. Final project goal

The project should leave the viewer with one clear idea:

```text
AI can decide what it wants to propose.

Cequre decides what the AI is allowed to do.
```

Everything in the implementation should support that idea.