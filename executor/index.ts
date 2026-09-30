/**
 * Guardrail executor worker.
 *
 *   bun run executor            # realtime: react to approvals over SSE
 *   bun run executor --poll     # fall back to polling the REST API
 *   bun run executor --once     # process the current approved batch and exit
 *
 * It never decides whether an action deserves approval. It only picks up
 * actions a human already approved and performs them, recording the result.
 */
import { ExecutorApi, type ExecutedAction } from "./cequre";
import { subscribeEvents } from "./sse";

const SUCCESS_MESSAGES: Record<string, string> = {
  refund: "Refund successfully processed.",
  close_ticket: "Conversation closed and the customer was notified.",
  escalate: "Issue escalated to a human administrator.",
};

type Logger = (message: string) => void;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function successMessage(action: ExecutedAction): string {
  return SUCCESS_MESSAGES[action.type] ?? "Action processed.";
}

/** Perform any approved actions currently queued. Returns how many ran. */
export async function runExecutorOnce(api: ExecutorApi, log: Logger = console.log): Promise<number> {
  const res = await api.listApproved();
  if (!res.ok) {
    throw new Error(`Failed to list approved actions: ${res.status} ${JSON.stringify(res.data)}`);
  }

  let processed = 0;
  for (const action of res.data.docs) {
    await performAction(api, action, log);
    processed++;
  }

  if (processed === 0) log("No approved actions waiting.");
  return processed;
}

/** Perform one action and record the outcome. */
export async function performAction(
  api: ExecutorApi,
  action: ExecutedAction,
  log: Logger = console.log
): Promise<boolean> {
  log(`\nExecuting action ${action.id}`);
  log(`  type:      ${action.type}`);
  log(`  customer:  ${action.customer}`);
  if (action.order) log(`  order:     ${action.order}`);
  log(`  reasoning: ${action.reasoning}`);

  const summary = successMessage(action);
  const updated = await api.markExecuted(action.id, summary);
  if (updated.ok) {
    log(`  ${summary}`);
    log(`  status: approved -> executed`);
    return true;
  }

  const failure = `${updated.status} ${JSON.stringify(updated.data)}`;
  log(`  execution failed: ${failure}`);
  await api.markFailed(action.id, `Execution failed: ${failure}`);
  log(`  status: approved -> failed`);
  return false;
}

export interface StreamOptions {
  signal: AbortSignal;
  log?: Logger;
  onConnect?: () => void;
  onExecuted?: (action: ExecutedAction) => void;
  /** Defaults to API_BASE_URL. */
  baseUrl?: string;
}

/**
 * Realtime mode: subscribe to the agent_actions channel and execute the moment
 * an admin approves, instead of polling.
 */
export async function runExecutorStream(
  api: ExecutorApi,
  options: StreamOptions
): Promise<void> {
  const base = (options.baseUrl ?? process.env.API_BASE_URL ?? "http://localhost").replace(
    /\/+$/,
    ""
  );
  const url = `${base}/api/sse?channel=agent_actions`;
  const log = options.log ?? console.log;

  for await (const event of subscribeEvents(url, {
    token: api.token,
    signal: options.signal,
    onOpen: options.onConnect,
  })) {
    if (event.event !== "agent_actions:updated") continue;

    const action = event.data as ExecutedAction;
    if (!action?.id || action.status !== "approved") continue;

    const ok = await performAction(api, action, log);
    if (ok) options.onExecuted?.(action);
  }
}

async function pollLoop(api: ExecutorApi, signal?: AbortSignal) {
  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 3000);
  console.log(`Polling for approved actions every ${intervalMs}ms...`);
  while (!signal?.aborted) {
    try {
      await runExecutorOnce(api);
    } catch (err: any) {
      console.error("Executor error:", err?.message ?? err);
    }
    await sleep(intervalMs);
  }
}

async function streamLoop(api: ExecutorApi) {
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    console.log("\nExecutor stopping.");
  });

  console.log("Executor streaming agent_actions over SSE...");
  let failures = 0;

  while (!controller.signal.aborted) {
    try {
      await runExecutorStream(api, {
        signal: controller.signal,
        log: console.log,
        onConnect: () => {
          failures = 0;
          console.log("SSE connected. Waiting for approvals...");
        },
      });
    } catch (err: any) {
      if (controller.signal.aborted) break;
      failures++;
      console.error(`SSE stream error (${failures}): ${err?.message ?? err}`);
      if (failures >= 3) {
        console.warn("Realtime unavailable after 3 attempts — falling back to polling.");
        await pollLoop(api, controller.signal);
        return;
      }
    }
    if (controller.signal.aborted) break;
    await sleep(1000);
  }
}

async function main() {
  const mode = process.argv.includes("--once")
    ? "once"
    : process.argv.includes("--poll")
      ? "poll"
      : "stream";

  const api = await ExecutorApi.connect(
    process.env.EXECUTOR_EMAIL ?? "executor@guardrail.dev",
    process.env.EXECUTOR_PASSWORD ?? "Passw0rd!123"
  );

  if (mode === "once") {
    await runExecutorOnce(api);
    return;
  }
  if (mode === "poll") {
    await pollLoop(api);
    return;
  }
  await streamLoop(api);
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\nExecutor failed:", err?.message ?? err);
      process.exit(1);
    });
}
