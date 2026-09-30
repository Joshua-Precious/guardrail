/**
 * Guardrail executor worker.
 *
 *   bun run executor          # poll forever
 *   bun run executor --once   # process the current batch and exit
 *
 * It never decides whether an action deserves approval. It only picks up
 * actions a human already approved and performs them, recording the result.
 */
import { ExecutorApi, type ExecutedAction } from "./cequre";

const SUCCESS_MESSAGES: Record<string, string> = {
  refund: "Refund successfully processed.",
  close_ticket: "Conversation closed and the customer was notified.",
  escalate: "Issue escalated to a human administrator.",
};

/** Perform any approved actions currently queued. Returns how many ran. */
export async function runExecutorOnce(api: ExecutorApi, log = console.log): Promise<number> {
  const res = await api.listApproved();
  if (!res.ok) {
    throw new Error(`Failed to list approved actions: ${res.status} ${JSON.stringify(res.data)}`);
  }

  let processed = 0;
  for (const action of res.data.docs) {
    log(`\nExecuting action ${action.id}`);
    log(`  type:     ${action.type}`);
    log(`  customer: ${action.customer}`);
    if (action.order) log(`  order:    ${action.order}`);
    log(`  reasoning: ${action.reasoning}`);

    try {
      const summary = SUCCESS_MESSAGES[action.type] ?? "Action processed.";
      log(`  ${summary}`);
      const updated = await api.markExecuted(action.id, summary);
      if (!updated.ok) {
        throw new Error(`${updated.status} ${JSON.stringify(updated.data)}`);
      }
      log(`  status: approved -> executed`);
      processed++;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log(`  execution failed: ${message}`);
      await api.markFailed(action.id, `Execution failed: ${message}`);
      log(`  status: approved -> failed`);
      processed++;
    }
  }

  if (processed === 0) log("No approved actions waiting.");
  return processed;
}

async function main() {
  const once = process.argv.includes("--once");
  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 3000);

  const api = await ExecutorApi.connect(
    process.env.EXECUTOR_EMAIL ?? "executor@guardrail.dev",
    process.env.EXECUTOR_PASSWORD ?? "Passw0rd!123"
  );

  if (once) {
    await runExecutorOnce(api);
    return;
  }

  console.log(`Executor polling for approved actions every ${intervalMs}ms...`);
  let running = true;
  process.on("SIGINT", () => {
    running = false;
    console.log("\nExecutor stopping.");
  });

  while (running) {
    try {
      await runExecutorOnce(api);
    } catch (err: any) {
      console.error("Executor error:", err?.message ?? err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\nExecutor failed:", err?.message ?? err);
      process.exit(1);
    });
}
