import type { ActionType, AgentApi } from "./cequre";
import type { ToolDefinition } from "./model";

/** Arguments available to tools that need conversation/context defaults. */
export interface ToolContext {
  conversationId: string;
  defaultCustomerId: string;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

export function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "get_customer",
      description: "Fetch a customer by id.",
      parameters: objectSchema({ customer_id: { type: "string" } }, ["customer_id"]),
    },
    {
      name: "get_order",
      description: "Fetch an order by id.",
      parameters: objectSchema({ order_id: { type: "string" } }, ["order_id"]),
    },
    {
      name: "list_orders",
      description: "List the orders belonging to a customer.",
      parameters: objectSchema({ customer_id: { type: "string" } }, ["customer_id"]),
    },
    {
      name: "reply_to_customer",
      description: "Send a reply to the customer in a conversation.",
      parameters: objectSchema(
        { conversation_id: { type: "string" }, content: { type: "string" } },
        ["content"]
      ),
    },
    {
      name: "propose_refund",
      description:
        "Propose a refund for human approval. This does NOT issue a refund; it creates a pending action.",
      parameters: objectSchema(
        { customer_id: { type: "string" }, order_id: { type: "string" }, reasoning: { type: "string" } },
        ["reasoning"]
      ),
    },
    {
      name: "propose_close_ticket",
      description:
        "Propose closing the conversation for human approval. Creates a pending action.",
      parameters: objectSchema({ reasoning: { type: "string" } }, ["reasoning"]),
    },
    {
      name: "propose_escalation",
      description:
        "Propose escalating the customer issue for human approval. Creates a pending action.",
      parameters: objectSchema({ reasoning: { type: "string" } }, ["reasoning"]),
    },
  ];
}

export interface ToolOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

const PROPOSAL_TYPES: Record<string, ActionType> = {
  propose_refund: "refund",
  propose_close_ticket: "close_ticket",
  propose_escalation: "escalate",
};

export async function executeTool(
  api: AgentApi,
  name: string,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "get_customer": {
        const res = await api.getCustomer(String(args.customer_id));
        return res.ok ? { ok: true, result: res.data } : { ok: false, error: `${res.status}` };
      }
      case "get_order": {
        const res = await api.getOrder(String(args.order_id));
        return res.ok ? { ok: true, result: res.data } : { ok: false, error: `${res.status}` };
      }
      case "list_orders": {
        const res = await api.listOrders(String(args.customer_id));
        return res.ok ? { ok: true, result: res.data.docs } : { ok: false, error: `${res.status}` };
      }
      case "reply_to_customer": {
        const conversationId = String(args.conversation_id ?? ctx.conversationId);
        const res = await api.replyToCustomer(conversationId, String(args.content ?? ""));
        return res.ok ? { ok: true, result: { id: (res.data as any).id } } : { ok: false, error: `${res.status}` };
      }
      default: {
        const type = PROPOSAL_TYPES[name];
        if (!type) return { ok: false, error: `unknown tool: ${name}` };
        const res = await api.proposeAction({
          type,
          customer: String(args.customer_id ?? ctx.defaultCustomerId),
          order: args.order_id ? String(args.order_id) : undefined,
          reasoning: String(args.reasoning ?? ""),
        });
        return res.ok
          ? { ok: true, result: { id: res.data.id, type: res.data.type, status: res.data.status } }
          : { ok: false, error: `${res.status} ${JSON.stringify(res.data)}` };
      }
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
