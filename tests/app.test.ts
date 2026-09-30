import { beforeAll, describe, expect, test } from "bun:test";
import { api } from "../lib/app";
import { setupDemo, type DemoContext } from "./helpers";

let demo: DemoContext;

beforeAll(async () => {
  demo = await setupDemo();
}, 60_000);

describe("Guardrail API surface", () => {
  test("health endpoint responds", async () => {
    const res = await api("GET", "/health");
    expect(res.status).toBe(200);
  });

  test("OpenAPI spec exposes the guardrail collections", async () => {
    const res = await api<{ paths?: Record<string, unknown> }>("GET", "/api/docs/openapi.json");
    expect(res.status).toBe(200);
    const paths = Object.keys(res.data.paths ?? {});
    for (const slug of ["agent_actions", "customers", "orders", "conversations", "messages"]) {
      expect(paths.some((path) => path.includes(slug))).toBe(true);
    }
  });

  test("collections are not readable without a token", async () => {
    expect((await api("GET", "/api/customers")).status).toBe(403);
    expect((await api("GET", "/api/agent_actions")).status).toBe(403);
  });

  test("agent can read the demo customer and order", async () => {
    const customer = await api("GET", `/api/customers/${demo.customer.id}`, {
      token: demo.agentToken,
    });
    expect(customer.status).toBe(200);

    const order = await api("GET", `/api/orders/${demo.order.id}`, { token: demo.agentToken });
    expect(order.status).toBe(200);
    expect((order.data as any).reference).toBe("1024");
  });
});
