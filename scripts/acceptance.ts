/**
 * End-to-end acceptance run for the Guardrail guarantee.
 *
 *   bun run acceptance          deterministic agent (scripted provider)
 *   bun run acceptance --live   the real model decides what to propose
 *
 * Proves, against the real request pipeline:
 *   agent proposes -> agent is denied approval (403) -> admin approves ->
 *   executor executes -> action is executed.
 *
 * Without --live the proposal step is a direct API call, so the run is
 * reproducible with no credentials. With --live the same guarantee is proven
 * after the configured model has chosen its own tools (see `bun run model:check`).
 */
import { approveAction, login } from "../lib/app";
import { AgentApi } from "../agent/cequre";
import { runAgent } from "../agent/index";
import { ExecutorApi } from "../executor/cequre";
import { runExecutorOnce } from "../executor/index";
import { ADMIN, AGENT, EXECUTOR, seed, type SeedResult } from "./seed";

const CUSTOMER_MESSAGE = "I was charged twice for order #1024. Please refund me.";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

/** Step [2]: how the proposal is created. */
async function createProposal(live: boolean, agent: AgentApi, seeded: SeedResult): Promise<string> {
  if (!live) {
    const proposal = await agent.proposeAction({
      type: "refund",
      customer: seeded.customer.id,
      order: seeded.order.id,
      reasoning: "Possible duplicate charge on an already-paid order.",
    });
    assert(proposal.ok, `proposal failed (${proposal.status})`);
    assert(proposal.data.status === "pending", "a proposal must start as pending");
    console.log(`    created ${proposal.data.id} (refund, pending)`);
    return proposal.data.id;
  }

  const provider = (process.env.AI_PROVIDER ?? "scripted").toLowerCase();
  if (provider === "scripted" || provider === "") {
    throw new Error(
      "--live needs a real provider; AI_PROVIDER is scripted. Run `bun run model:check`."
    );
  }
  console.log(`    provider=${provider} model=${process.env.AI_MODEL ?? "(unset)"}`);
  console.log("    letting the model choose its own tools...\n");

  const run = await runAgent({
    api: agent,
    userMessage: CUSTOMER_MESSAGE,
    ctx: { conversationId: seeded.conversation.id, defaultCustomerId: seeded.customer.id },
    context: {
      customerId: seeded.customer.id,
      customerName: seeded.customer.name,
      orderId: seeded.order.id,
      orderReference: seeded.order.reference,
      conversationId: seeded.conversation.id,
    },
  });

  for (const entry of run.transcript) {
    const outcome = entry.outcome as { ok?: boolean; error?: string };
    console.log(`      -> ${entry.tool}${outcome.ok === false ? ` (failed: ${outcome.error})` : ""}`);
  }

  assert(run.proposedActionIds.length > 0, "the model never proposed a risky action");
  const actionId = run.proposedActionIds[0];
  const proposal = await agent.getAction(actionId);
  assert(proposal.ok, "should be able to read the model's proposal back");
  assert(proposal.data.status === "pending", `a proposal must start as pending, got ${proposal.data.status}`);
  console.log(`    created ${actionId} (${proposal.data.type}, pending)`);
  console.log(`\n    model reply: ${run.content.trim().split("\n")[0]}`);
  return actionId;
}

async function main() {
  const live = process.argv.includes("--live");
  const seeded = await seed();
  const agent = await AgentApi.connect(AGENT.email, AGENT.password);

  console.log("\n[1] Agent reads the customer's order");
  const order = await agent.getOrder(seeded.order.id);
  assert(order.ok, `agent should be able to read the order (got ${order.status})`);
  console.log(
    `    order #${order.data.reference}: ${order.data.amount} ${order.data.status}`
  );

  console.log("\n[2] Agent proposes a refund");
  const actionId = await createProposal(live, agent, seeded);

  console.log("\n[3] Agent attempts to approve its own proposal");
  const attempt = await agent.attemptSelfApproval(actionId);
  assert(attempt.status === 403, `expected 403, got ${attempt.status}`);
  console.log(`    HTTP ${attempt.status} Forbidden — blocked by the schema access rules`);

  console.log("\n[4] Human administrator approves it");
  const adminToken = await login("admins", ADMIN.email, ADMIN.password);
  const approved = await approveAction(adminToken, actionId);
  assert(approved.ok, `admin approval failed (${approved.status} ${JSON.stringify(approved.data)})`);
  console.log("    pending -> approved");

  console.log("\n[5] Executor performs the approved action");
  const executor = await ExecutorApi.connect(EXECUTOR.email, EXECUTOR.password);
  const processed = await runExecutorOnce(executor);
  assert(processed >= 1, "the executor should have processed the approved action");

  console.log("\n[6] Verify the final state");
  const final = await agent.getAction(actionId);
  assert(final.ok, "should be able to read the action back");
  assert(final.data.status === "executed", `expected executed, got ${final.data.status}`);
  assert(Boolean(final.data.result), "the executor should have recorded a result");
  console.log(`    status=${final.data.status} result="${final.data.result}"`);

  console.log(
    `\nPASS${live ? " (live model)" : ""} — the agent could propose the action. Only a human could approve it.\n`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nAcceptance FAILED:", err?.message ?? err);
    process.exit(1);
  });
