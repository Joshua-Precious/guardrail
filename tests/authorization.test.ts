/**
 * The core security boundary, exercised through the real request pipeline.
 *
 *   agent -> create (allowed)      agent -> update (denied, 403)
 *   admin -> approve (allowed)     executor -> execute (allowed)
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { api, approveAction, executeAction, rejectAction } from "../lib/app";
import { ExecutorApi } from "../executor/cequre";
import { runExecutorOnce } from "../executor/index";
import { createProposal, setupDemo, type DemoContext } from "./helpers";

let demo: DemoContext;

beforeAll(async () => {
  demo = await setupDemo();
}, 60_000);

describe("agent_actions role matrix", () => {
  test("agent can create a proposal (201, pending)", async () => {
    const res = await createProposal(demo);
    expect(res.status).toBe(201);
    expect(res.data.status).toBe("pending");
  });

  test("a proposal is forced to pending even if the agent asks for approved", async () => {
    const res = await api<{ status: string }>("POST", "/api/agent_actions", {
      token: demo.agentToken,
      body: {
        type: "refund",
        status: "approved",
        customer: demo.customer.id,
        reasoning: "trying to skip review",
      },
    });
    expect(res.status).toBe(201);
    expect(res.data.status).toBe("pending");
  });

  test("agent cannot approve its own proposal (403)", async () => {
    const created = await createProposal(demo);
    const res = await api("PATCH", `/api/agent_actions/${created.data.id}`, {
      token: demo.agentToken,
      body: { status: "approved" },
    });
    expect(res.status).toBe(403);
  });

  test("agent cannot update a proposal at all (403)", async () => {
    const created = await createProposal(demo);
    const res = await api("PATCH", `/api/agent_actions/${created.data.id}`, {
      token: demo.agentToken,
      body: { result: "refunded" },
    });
    expect(res.status).toBe(403);
  });

  test("admin can approve a pending proposal (200)", async () => {
    const created = await createProposal(demo);
    const res = await api<{ status: string }>(
      "PATCH",
      `/api/agent_actions/${created.data.id}`,
      { token: demo.adminToken, body: { status: "approved" } }
    );
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("approved");
  });

  test("admin cannot skip straight to executed (403)", async () => {
    const created = await createProposal(demo);
    const res = await api(
      "PATCH",
      `/api/agent_actions/${created.data.id}`,
      { token: demo.adminToken, body: { status: "executed" } }
    );
    expect(res.status).toBe(403);
  });

  test("executor cannot approve (403)", async () => {
    const created = await createProposal(demo);
    const res = await api(
      "PATCH",
      `/api/agent_actions/${created.data.id}`,
      { token: demo.executorToken, body: { status: "approved" } }
    );
    expect(res.status).toBe(403);
  });

  test("executor cannot execute a pending (unapproved) action (403)", async () => {
    const created = await createProposal(demo);
    const res = await api(
      "PATCH",
      `/api/agent_actions/${created.data.id}`,
      { token: demo.executorToken, body: { status: "executed" } }
    );
    expect(res.status).toBe(403);
  });

  test("executor can execute an approved action (200) and records a result", async () => {
    const created = await createProposal(demo);
    const approved = await api(
      "PATCH",
      `/api/agent_actions/${created.data.id}`,
      { token: demo.adminToken, body: { status: "approved" } }
    );
    expect(approved.status).toBe(200);

    const executed = await api<{ status: string; result?: string }>(
      "PATCH",
      `/api/agent_actions/${created.data.id}`,
      { token: demo.executorToken, body: { status: "executed", result: "Refund processed." } }
    );
    expect(executed.status).toBe(200);
    expect(executed.data.status).toBe("executed");
    expect(executed.data.result).toBe("Refund processed.");
  });

  test("unauthenticated create is denied (403)", async () => {
    const res = await api("POST", "/api/agent_actions", {
      body: { type: "refund", customer: demo.customer.id, reasoning: "anon" },
    });
    expect(res.status).toBe(403);
  });
});

describe("executor worker", () => {
  test("runExecutorOnce executes an approved action end to end", async () => {
    const created = await createProposal(demo);
    await api("PATCH", `/api/agent_actions/${created.data.id}`, {
      token: demo.adminToken,
      body: { status: "approved" },
    });

    const executor = await ExecutorApi.connect(
      process.env.EXECUTOR_EMAIL ?? "executor@guardrail.dev",
      process.env.EXECUTOR_PASSWORD ?? "Passw0rd!123"
    );
    const processed = await runExecutorOnce(executor, () => {});
    expect(processed).toBeGreaterThanOrEqual(1);

    const final = await api<{ status: string; result?: string }>(
      "GET",
      `/api/agent_actions/${created.data.id}`,
      { token: demo.agentToken }
    );
    expect(final.data.status).toBe("executed");
    expect(final.data.result).toBeTruthy();
  });
});

describe("semantic approval endpoints", () => {
  test("admin can approve via /approve (200)", async () => {
    const created = await createProposal(demo);
    const res = await approveAction(demo.adminToken, created.data.id);
    expect(res.status).toBe(200);
    expect((res.data as any).status).toBe("approved");
  });

  test("admin can reject via /reject (200)", async () => {
    const created = await createProposal(demo);
    const res = await rejectAction(demo.adminToken, created.data.id);
    expect(res.status).toBe(200);
    expect((res.data as any).status).toBe("rejected");
  });

  test("agent cannot use /approve (403)", async () => {
    const created = await createProposal(demo);
    const res = await approveAction(demo.agentToken, created.data.id);
    expect(res.status).toBe(403);
  });

  test("executor cannot use /approve (403)", async () => {
    const created = await createProposal(demo);
    const res = await approveAction(demo.executorToken, created.data.id);
    expect(res.status).toBe(403);
  });

  test("executor executes an approved action via /execute (200)", async () => {
    const created = await createProposal(demo);
    await approveAction(demo.adminToken, created.data.id);
    const res = await executeAction(demo.executorToken, created.data.id, {
      result: "Refund processed via endpoint.",
    });
    expect(res.status).toBe(200);
    expect((res.data as any).status).toBe("executed");
    expect((res.data as any).result).toBe("Refund processed via endpoint.");
  });

  test("executor cannot /execute a pending action (403)", async () => {
    const created = await createProposal(demo);
    const res = await executeAction(demo.executorToken, created.data.id);
    expect(res.status).toBe(403);
  });

  test("unauthenticated /approve is denied (403)", async () => {
    const created = await createProposal(demo);
    const res = await api("POST", `/api/agent_actions/${created.data.id}/approve`);
    expect(res.status).toBe(403);
  });
});
