/**
 * Realtime executor: an admin approval is pushed over SSE and the executor
 * performs the action without polling.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, approveAction } from "../lib/app";
import { startHttpServer, type HttpServer } from "../lib/server";
import { ExecutorApi } from "../executor/cequre";
import { runExecutorStream } from "../executor/index";
import { subscribeEvents } from "../executor/sse";
import { createProposal, setupDemo, type DemoContext } from "./helpers";

let demo: DemoContext;
let server: HttpServer;
let executor: ExecutorApi;

const timeout = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  demo = await setupDemo();
  executor = await ExecutorApi.connect(
    process.env.EXECUTOR_EMAIL ?? "executor@guardrail.dev",
    process.env.EXECUTOR_PASSWORD ?? "Passw0rd!123"
  );
  server = await startHttpServer();
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

describe("realtime executor over SSE", () => {
  test("the agent_actions channel delivers the approval event", async () => {
    const controller = new AbortController();
    const stream = subscribeEvents(`${server.url}/api/sse?channel=agent_actions`, {
      token: executor.token,
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();

    const connected = await iterator.next();
    expect(connected.value?.event).toBe("connected");

    const created = await createProposal(demo);
    const approved = await approveAction(demo.adminToken, created.data.id);
    expect(approved.status).toBe(200);

    let found: any = null;
    for (let i = 0; i < 12 && !found; i++) {
      const next: any = await Promise.race([iterator.next(), timeout(2000).then(() => null)]);
      if (!next || next.done) break;
      const event = next.value;
      if (
        event.event === "agent_actions:updated" &&
        event.data?.id === created.data.id &&
        event.data?.status === "approved"
      ) {
        found = event;
      }
    }

    controller.abort();
    expect(found).not.toBeNull();
    expect(found.data.status).toBe("approved");
  }, 30_000);

  test("the executor executes the moment an admin approves", async () => {
    const controller = new AbortController();
    let resolveExecuted!: (id: string) => void;
    let resolveConnected!: () => void;
    const executed = new Promise<string>((resolve) => (resolveExecuted = resolve));
    const connected = new Promise<void>((resolve) => (resolveConnected = resolve));

    const streaming = runExecutorStream(executor, {
      signal: controller.signal,
      baseUrl: server.url,
      log: () => {},
      onConnect: () => resolveConnected(),
      onExecuted: (action) => resolveExecuted(action.id),
    });

    await connected;

    const created = await createProposal(demo);
    await approveAction(demo.adminToken, created.data.id);

    const executedId = await Promise.race([executed, timeout(5000).then(() => null)]);
    controller.abort();
    await streaming.catch(() => {});

    expect(executedId).toBe(created.data.id);

    const final = await api<{ status: string; result?: string }>(
      "GET",
      `/api/agent_actions/${created.data.id}`,
      { token: demo.agentToken }
    );
    expect(final.data.status).toBe("executed");
    expect(final.data.result).toBeTruthy();
  }, 30_000);
});
