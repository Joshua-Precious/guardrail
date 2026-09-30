# Guardrail — Manual API Testing Guide (cURL / HTTP)

This guide shows you how to manually test the API endpoints directly using `curl` (or Postman / Thunder Client / Insomnia) without any test runners or wrapper scripts.

Make sure your Cequre dev server is running on `http://localhost:3000`.

---

## Step 1: Obtain JWT Tokens for Each Role

The system has three distinct actors. You will log in as each one and grab their JWT access token.

### 1. Agent Login
```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{"email":"agent@guardrail.dev","password":"Passw0rd!123"}'
```
*Save the `accessToken` as `AGENT_TOKEN`.*

### 2. Admin Login
```bash
curl -X POST http://localhost:3000/api/admins/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@guardrail.dev","password":"Passw0rd!123"}'
```
*Save the `accessToken` as `ADMIN_TOKEN`.*

### 3. Executor Login
```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{"email":"executor@guardrail.dev","password":"Passw0rd!123"}'
```
*Save the `accessToken` as `EXECUTOR_TOKEN`.*

---

## Tip: Quick Setup in Your Terminal

You can paste this block into your bash terminal to automatically log in and set all environment variables:

```bash
export AGENT_TOKEN=$(curl -s -X POST http://localhost:3000/api/users/login -H "Content-Type: application/json" -d '{"email":"agent@guardrail.dev","password":"Passw0rd!123"}' | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)

export ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/api/admins/login -H "Content-Type: application/json" -d '{"email":"admin@guardrail.dev","password":"Passw0rd!123"}' | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)

export EXECUTOR_TOKEN=$(curl -s -X POST http://localhost:3000/api/users/login -H "Content-Type: application/json" -d '{"email":"executor@guardrail.dev","password":"Passw0rd!123"}' | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)

echo "Agent Token:    ${AGENT_TOKEN:0:20}..."
echo "Admin Token:    ${ADMIN_TOKEN:0:20}..."
echo "Executor Token: ${EXECUTOR_TOKEN:0:20}..."
```

---

## Step 2: Agent Reads Customer & Order Data

The agent has read access to inspect the customer and order.

### List customers:
```bash
curl -s http://localhost:3000/api/customers \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

### List orders:
```bash
curl -s http://localhost:3000/api/orders \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

Pick the customer's `id` (e.g. `01M3S9MV5H9PXQ5R6K4JTXVS7K`) and order's `id`.

---

## Step 3: Agent Proposes a Refund (Allowed)

The agent creates a new entry in `agent_actions`. Notice status starts as `pending`.

```bash
curl -i -X POST http://localhost:3000/api/agent_actions \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "refund",
    "customer": "01M3S9MV5H9PXQ5R6K4JTXVS7K",
    "reasoning": "Customer reported duplicate charge for order #1024"
  }'
```

**Expected Response**: `201 Created`
```json
{
  "id": "01M3SC...",
  "type": "refund",
  "status": "pending",
  "customer": "01M3S9MV5H9PXQ5R6K4JTXVS7K",
  "reasoning": "Customer reported duplicate charge for order #1024"
}
```

*Copy the `id` from the response (or `export ACTION_ID="<id>"`).*

---

## Step 4: The Core Test — Agent Tries to Approve It (Rejected!)

Now simulate what happens if an LLM goes rogue or attempts to execute/approve the action itself.

### Test A: Via `/approve` endpoint:
```bash
curl -i -X POST "http://localhost:3000/api/agent_actions/$ACTION_ID/approve" \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

### Test B: Via direct `PATCH`:
```bash
curl -i -X PATCH "http://localhost:3000/api/agent_actions/$ACTION_ID" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"approved"}'
```

**Expected Response in Both Cases**: `HTTP/1.1 403 Forbidden`
```json
{
  "code": "FORBIDDEN",
  "message": "Unauthorized to update on agent_actions (DSL Denied)",
  "statusCode": 403
}
```
> 🔥 **This is the core security boundary.** The agent has no update permission defined in `agent_actions.cequre`.

---

## Step 5: Admin Approves the Action (Allowed)

Now call the approve endpoint using the **Admin** token:

```bash
curl -i -X POST "http://localhost:3000/api/agent_actions/$ACTION_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Expected Response**: `HTTP/1.1 200 OK`
```json
{
  "id": "01M3SC...",
  "type": "refund",
  "status": "approved",
  "reasoning": "Customer reported duplicate charge for order #1024"
}
```

Status transitioned from `pending` -> `approved`.

---

## Step 6: Executor Performs the Action (Allowed)

Now that a human has approved it, the executor reports the execution result:

```bash
curl -i -X POST "http://localhost:3000/api/agent_actions/$ACTION_ID/execute" \
  -H "Authorization: Bearer $EXECUTOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"result":"Refund of ₦45,000 processed to customer card."}'
```

**Expected Response**: `HTTP/1.1 200 OK`
```json
{
  "id": "01M3SC...",
  "type": "refund",
  "status": "executed",
  "result": "Refund of ₦45,000 processed to customer card."
}
```

---

## Step 7: Verify Final Record

Check the action state with any token:

```bash
curl -s "http://localhost:3000/api/agent_actions/$ACTION_ID" \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

Status is now `executed`, with the outcome attached, proving the complete authorization lifecycle.
