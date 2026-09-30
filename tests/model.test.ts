/**
 * Proves the provider-neutral "live" path: the real OpenAICompatibleClient
 * speaks the Chat Completions tool-calling wire format against a stub server,
 * and the agent loop still drives the real Cequre backend.
 *
 * Swap AI_BASE_URL/AI_MODEL/AI_API_KEY for a real provider and the same code
 * path runs unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AgentApi } from "../agent/cequre";
import { runAgent } from "../agent/index";
import { OpenAICompatibleClient } from "../agent/model";
import { createProposal, setupDemo, type DemoContext } from "./helpers";

let demo: DemoContext;
let server: ReturnType<typeof Bun.serve>;
let calls = 0;
let sawAuthHeader = "";
let sawToolDefinitions: string[] = [];

function completion(message: Record<string, unknown>) {
  return Response.json({ choices: [{ message }] });
}

beforeAll(async () => {
  demo = await setupDemo();

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls++;
      sawAuthHeader = req.headers.get("authorization") ?? "";
      const body: any = await req.json();
      sawToolDefinitions = (body.tools ?? []).map((t: any) => t.function?.name);

      if (calls === 1) {
        return completion({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_customer",
                arguments: JSON.stringify({ customer_id: demo.customer.id }),
              },
            },
          ],
        });
      }
      if (calls === 2) {
        return completion({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: {
                name: "propose_refund",
                arguments: JSON.stringify({
                  customer_id: demo.customer.id,
                  order_id: demo.order.id,
                  reasoning: "Duplicate charge reported by the customer.",
                }),
              },
            },
          ],
        });
      }
      return completion({
        role: "assistant",
        content: "I've submitted your refund request for human review.",
      });
    },
  });
}, 60_000);

afterAll(() => {
  server?.stop(true);
});

describe("provider-neutral live path", () => {
  test("the agent proposes a pending action through an OpenAI-compatible model", async () => {
    const saved = {
      provider: process.env.AI_PROVIDER,
      baseUrl: process.env.AI_BASE_URL,
      model: process.env.AI_MODEL,
      apiKey: process.env.AI_API_KEY,
    };
    process.env.AI_PROVIDER = "openai-compatible";
    process.env.AI_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    process.env.AI_MODEL = "stub-model";
    process.env.AI_API_KEY = "stub-key";

    try {
      const api = await AgentApi.connect(
        process.env.AGENT_EMAIL ?? "agent@guardrail.dev",
        process.env.AGENT_PASSWORD ?? "Passw0rd!123"
      );

      const result = await runAgent({
        api,
        userMessage: "I was charged twice for order #1024. Please refund me.",
        ctx: { conversationId: demo.conversation.id, defaultCustomerId: demo.customer.id },
        model: new OpenAICompatibleClient(),
        context: {
          customerId: demo.customer.id,
          orderId: demo.order.id,
          conversationId: demo.conversation.id,
        },
      });

      // The model was called over HTTP with the tool schema and the key.
      expect(sawAuthHeader).toBe("Bearer stub-key");
      expect(sawToolDefinitions).toContain("propose_refund");
      expect(calls).toBeGreaterThanOrEqual(3);

      // A pending proposal exists, and the agent still cannot approve it.
      expect(result.proposedActionIds.length).toBe(1);
      const actionId = result.proposedActionIds[0];
      const fetched = await api.getAction(actionId);
      expect(fetched.data.status).toBe("pending");

      const attempt = await api.attemptSelfApproval(actionId);
      expect(attempt.status).toBe(403);
    } finally {
      process.env.AI_PROVIDER = saved.provider;
      process.env.AI_BASE_URL = saved.baseUrl;
      process.env.AI_MODEL = saved.model;
      process.env.AI_API_KEY = saved.apiKey;
    }
  }, 60_000);

  test("unknown provider config fails loudly", async () => {
    const { createModelClient } = await import("../agent/model");
    const saved = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = "nope";
    try {
      expect(() => createModelClient()).toThrow(/Unknown AI_PROVIDER/);
    } finally {
      process.env.AI_PROVIDER = saved;
    }
  });
});
