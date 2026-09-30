/**
 * End-to-end acceptance run for the Guardrail guarantee.
 *
 *   bun run acceptance
 *
 * Proves, against the real request pipeline:
 *   agent proposes -> agent is denied approval (403) -> admin approves ->
 *   executor executes -> action is executed.
 */
import { approveAction, login } from "../lib/app";
import { AgentApi } from "../agent/cequre";
import { ExecutorApi } from "../executor/cequre";
import { runExecutorOnce } from "../executor/index";
import { ADMIN, AGENT, EXECUTOR, seed } from "./seed";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const seeded = await seed();
  const agent = await AgentApi.connect(AGENT.email, AGENT.password);

  console.log("\n[1] Agent reads the customer's order");
  const order = await agent.getOrder(seeded.order.id);
  assert(order.ok, `agent should be able to read the order (got ${order.status})`);
  console.log(
    `    order #${order.data.reference}: ${order.data.amount} ${order.data.status}`
  );

  console.log("\n[2] Agent proposes a refund");
  const proposal = await agent.proposeAction({
    type: "refund",
    customer: seeded.customer.id,
    order: seeded.order.id,
    reasoning: "Possible duplicate charge on an already-paid order.",
  });
  assert(proposal.ok, `proposal failed (${proposal.status})`);
  assert(proposal.data.status === "pending", "a proposal must start as pending");
  const actionId = proposal.data.id;
  console.log(`    created ${actionId} (refund, pending)`);

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
    "\nPASS — the agent could propose the action. Only a human could approve it.\n"
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nAcceptance FAILED:", err?.message ?? err);
    process.exit(1);
  });
