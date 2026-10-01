/**
 * Adversarial tests: try to break the human-in-the-loop boundary rather than
 * just exercise the happy path.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { api, approveAction, executeAction, rejectAction } from "../lib/app";
import { register } from "../lib/app";
import { createProposal, setupDemo, type DemoContext } from "./helpers";

let demo: DemoContext;

beforeAll(async () => {
  demo = await setupDemo();
}, 60_000);

/** Re-encode a JWT payload with a different role, keeping the old signature. */
function escalateToken(token: string, role: string): string {
  const [header, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  claims.role = role;
  const tampered = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${tampered}.${signature}`;
}

describe("agent cannot escalate its own authority", () => {
  test("cannot delete a proposal", async () => {
    const created = await createProposal(demo);
    const res = await api("DELETE", `/api/agent_actions/${created.data.id}`, {
      token: demo.agentToken,
    });
    expect(res.status).toBe(403);
  });

  test("cannot reject", async () => {
    const created = await createProposal(demo);
    const res = await api("PATCH", `/api/agent_actions/${created.data.id}`, {
      token: demo.agentToken,
      body: { status: "rejected" },
    });
    expect(res.status).toBe(403);
  });

  test("cannot execute", async () => {
    const created = await createProposal(demo);
    const res = await api("PATCH", `/api/agent_actions/${created.data.id}`, {
      token: demo.agentToken,
      body: { status: "executed" },
    });
    expect(res.status).toBe(403);
  });

  test("cannot smuggle an approved status or a result in on create", async () => {
    const res = await api<{ status: string; result?: string }>("POST", "/api/agent_actions", {
      token: demo.agentToken,
      body: {
        type: "refund",
        status: "approved",
        result: "already refunded",
        customer: demo.customer.id,
        reasoning: "smuggle attempt",
      },
    });
    expect(res.status).toBe(201);
    expect(res.data.status).toBe("pending");
    expect(res.data.result ?? null).toBeNull(); // the smuggled result did not persist
  });

  test("a plain user role cannot create proposals", async () => {
    const email = `plain-${Date.now()}@guardrail.dev`;
    const created = await register(
      "users",
      { name: "Plain User", email, password: "Passw0rd!123", role: "user" },
      demo.adminToken
    );
    expect(created.status).toBe(201);
    const userToken = created.data.accessToken as string;

    const res = await api("POST", "/api/agent_actions", {
      token: userToken,
      body: { type: "refund", customer: demo.customer.id, reasoning: "not my job" },
    });
    expect(res.status).toBe(403);
  });
});

describe("replay and tampering", () => {
  test("an executor cannot re-run an already-executed action", async () => {
    const created = await createProposal(demo);
    await approveAction(demo.adminToken, created.data.id);
    const first = await executeAction(demo.executorToken, created.data.id, { result: "done" });
    expect(first.status).toBe(200);

    const replay = await executeAction(demo.executorToken, created.data.id, { result: "again" });
    expect(replay.status).toBe(403);

    const final = await api<{ result: string }>("GET", `/api/agent_actions/${created.data.id}`, {
      token: demo.agentToken,
    });
    expect(final.data.result).toBe("done");
  });

  test("an executor cannot reject or rewrite a proposal", async () => {
    const created = await createProposal(demo);
    const approved = await approveAction(demo.adminToken, created.data.id);
    expect(approved.status).toBe(200);

    const rejected = await api("PATCH", `/api/agent_actions/${created.data.id}`, {
      token: demo.executorToken,
      body: { status: "rejected" },
    });
    expect(rejected.status).toBe(403);

    // Extra fields are stripped: the executor may only report status/result.
    const executed = await executeAction(demo.executorToken, created.data.id, { result: "ok" });
    expect(executed.status).toBe(200);

    const final = await api<{ reasoning: string }>("GET", `/api/agent_actions/${created.data.id}`, {
      token: demo.agentToken,
    });
    expect(final.data.reasoning).toBe("Automated test proposal");
  });

  test("a token whose role was escalated in the payload is rejected", async () => {
    const forged = escalateToken(demo.agentToken, "admin");
    expect(forged).not.toBe(demo.agentToken);

    const created = await createProposal(demo);

    const res = await approveAction(forged, created.data.id);
    expect([401, 403]).toContain(res.status);

    // The action is untouched and still awaiting a real human.
    const check = await api<{ status: string }>("GET", `/api/agent_actions/${created.data.id}`, {
      token: demo.agentToken,
    });
    expect(check.data.status).toBe("pending");
  });

  test("a garbage token is rejected", async () => {
    const created = await createProposal(demo);
    const res = await rejectAction("not.a.jwt", created.data.id);
    expect([401, 403]).toContain(res.status);
  });
});

describe("malformed payloads never reach the hooks", () => {
  test("an unknown enum value is rejected", async () => {
    const res = await api<{ message: string }>("POST", "/api/agent_actions", {
      token: demo.agentToken,
      body: { type: "wire_transfer", customer: demo.customer.id, reasoning: "x" },
    });
    expect(res.status).toBe(400);
    expect(res.data.message).toContain("/type");
  });

  test("a missing required field is rejected", async () => {
    const res = await api<{ message: string }>("POST", "/api/agent_actions", {
      token: demo.agentToken,
      body: { type: "refund", reasoning: "x" },
    });
    expect(res.status).toBe(400);
    expect(res.data.message).toContain("/customer");
  });

  test("a wrongly typed field is rejected", async () => {
    const res = await api<{ message: string }>("POST", "/api/agent_actions", {
      token: demo.agentToken,
      body: { type: "refund", customer: demo.customer.id, reasoning: 12345 },
    });
    expect(res.status).toBe(400);
    expect(res.data.message).toContain("/reasoning");
  });

  test("an undeclared field is rejected", async () => {
    const res = await api<{ message: string }>("POST", "/api/agent_actions", {
      token: demo.agentToken,
      body: { type: "refund", customer: demo.customer.id, reasoning: "x", bogus: "y" },
    });
    expect(res.status).toBe(400);
    expect(res.data.message).toContain("/bogus");
  });
});
