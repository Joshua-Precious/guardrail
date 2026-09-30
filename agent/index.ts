/**
 * Guardrail agent worker.
 *
 *   bun run agent "I was charged twice for order #1024. Please refund me."
 *
 * It reads customer/order data, proposes a risky action, and replies to the
 * customer. Risky tools only ever create `pending` proposals — the agent has
 * no update permission on agent_actions at all.
 *
 * The model is provider-neutral (see agent/model.ts). Defaults to the
 * deterministic `scripted` provider so the demo runs without an API key.
 */
import { AgentApi, type ActionType, type Conversation, type Customer, type Order } from "./cequre";
import { createModelClient, type ChatMessage, type ModelClient, type ScriptedScenario } from "./model";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts";
import { executeTool, toolDefinitions, type ToolContext } from "./tools";

export interface AgentRunResult {
  content: string;
  transcript: Array<{ tool: string; outcome: unknown }>;
  proposedActionIds: string[];
}

export async function runAgent(options: {
  api: AgentApi;
  userMessage: string;
  ctx: ToolContext;
  scenario?: ScriptedScenario;
  model?: ModelClient;
  maxSteps?: number;
  context?: Omit<Parameters<typeof buildUserPrompt>[0], "message">;
}): Promise<AgentRunResult> {
  const { api, userMessage, ctx } = options;
  const model = options.model ?? createModelClient(options.scenario);
  const tools = toolDefinitions();
  const maxSteps = options.maxSteps ?? 8;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt({ message: userMessage, ...options.context }) },
  ];

  const transcript: AgentRunResult["transcript"] = [];
  const proposedActionIds: string[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const result = await model.chat(messages, tools);

    if (!result.toolCalls.length) {
      return {
        content: result.content ?? "(agent produced no response)",
        transcript,
        proposedActionIds,
      };
    }

    messages.push({
      role: "assistant",
      content: result.content ?? undefined,
      toolCalls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      const outcome = await executeTool(api, call.name, call.arguments, ctx);
      transcript.push({ tool: call.name, outcome });
      if (call.name.startsWith("propose_") && outcome.ok) {
        proposedActionIds.push((outcome.result as { id: string }).id);
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(outcome),
      });
    }
  }

  throw new Error(`Agent exceeded ${maxSteps} steps without finishing`);
}

// --- CLI ------------------------------------------------------------------

interface CliArgs {
  message: string;
  customerEmail?: string;
  customerId?: string;
  orderReference?: string;
  orderId?: string;
  conversationId?: string;
  action: ActionType;
  selfApprove: boolean;
}

const FINAL_MESSAGES: Record<ActionType, string> = {
  refund:
    "I've submitted your refund request for human review. A support administrator will review it before any refund is issued.",
  close_ticket:
    "I've submitted a request to close this conversation for human review.",
  escalate:
    "I've escalated your issue to a human administrator for review.",
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    message: "I was charged twice for order #1024. Please refund me.",
    action: "refund",
    selfApprove: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--customer-email") args.customerEmail = argv[++i];
    else if (arg === "--customer-id") args.customerId = argv[++i];
    else if (arg === "--order") args.orderReference = argv[++i];
    else if (arg === "--order-id") args.orderId = argv[++i];
    else if (arg === "--conversation") args.conversationId = argv[++i];
    else if (arg === "--action") args.action = argv[++i] as ActionType;
    else if (arg === "--self-approve") args.selfApprove = true;
    else if (!arg.startsWith("--")) positional.push(arg);
  }
  if (positional.length) args.message = positional.join(" ");
  const lower = args.message.toLowerCase();
  if (lower.includes("close") || lower.includes("cancel my ticket")) args.action = "close_ticket";
  else if (lower.includes("escalate") || lower.includes("manager")) args.action = "escalate";
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const api = await AgentApi.connect(
    process.env.AGENT_EMAIL ?? "agent@guardrail.dev",
    process.env.AGENT_PASSWORD ?? "Passw0rd!123"
  );

  const customer =
    (args.customerId ? (await api.getCustomer(args.customerId)).data : undefined) ??
    (args.customerEmail
      ? await api.findOne<Customer>("customers", { email: { eq: args.customerEmail } })
      : await api.findOne<Customer>("customers", { name: { eq: "John Doe" } }));

  const order =
    (args.orderId ? (await api.getOrder(args.orderId)).data : undefined) ??
    (args.orderReference
      ? await api.findOne<Order>("orders", { reference: { eq: args.orderReference } })
      : await api.findOne<Order>("orders", { reference: { eq: "1024" } }));

  const conversation =
    (args.conversationId
      ? ((await api.findOne<Conversation>("conversations", { id: { eq: args.conversationId } })) ??
        ({ id: args.conversationId } as Conversation))
      : undefined) ??
    (customer
      ? await api.findOne<Conversation>("conversations", { customer: { eq: customer.id } })
      : undefined);

  if (!customer || !conversation) {
    throw new Error("Run `bun run seed` first: demo customer/conversation not found");
  }

  const ctx: ToolContext = { conversationId: conversation.id, defaultCustomerId: customer.id };

  const scenario: ScriptedScenario = {
    steps: [
      { name: "get_customer", arguments: { customer_id: customer.id } },
      ...(order ? [{ name: "get_order", arguments: { order_id: order.id } }] : []),
      {
        name: `propose_${
          args.action === "refund" ? "refund" : args.action === "escalate" ? "escalation" : "close_ticket"
        }`,
        arguments: {
          customer_id: customer.id,
          order_id: order?.id,
          reasoning: `Customer reports an issue with ${
            order ? `order #${order.reference} (${order.status})` : "their account"
          }. Proposed action requires human approval.`,
        },
      },
      {
        name: "reply_to_customer",
        arguments: { conversation_id: conversation.id, content: FINAL_MESSAGES[args.action] },
      },
    ],
    finalMessage: FINAL_MESSAGES[args.action],
  };

  console.log(`\nCustomer message: "${args.message}"\n`);
  const result = await runAgent({
    api,
    userMessage: args.message,
    ctx,
    scenario,
    context: {
      customerId: customer.id,
      customerName: customer.name,
      orderId: order?.id,
      orderReference: order?.reference,
      conversationId: conversation.id,
    },
  });

  for (const entry of result.transcript) {
    console.log(`  -> ${entry.tool}: ${JSON.stringify(entry.outcome)}`);
  }
  console.log(`\nAgent reply: ${result.content}`);

  if (result.proposedActionIds.length) {
    const id = result.proposedActionIds[0];
    console.log(`\nProposal created: ${id} (status: pending)`);

    if (args.selfApprove) {
      const attempt = await api.attemptSelfApproval(id);
      console.log(
        `\nAgent attempt to self-approve: HTTP ${attempt.status}${
          attempt.status === 403 ? " (blocked by Cequre access rules)" : ""
        }`
      );
    }
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\nAgent failed:", err?.message ?? err);
      process.exit(1);
    });
}
