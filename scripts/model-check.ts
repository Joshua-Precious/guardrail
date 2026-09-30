/**
 * Preflight for the agent's model provider.
 *
 *   bun run model:check
 *
 * Prints the resolved configuration and, for a real provider, makes one tiny
 * call to confirm the base URL / model / key all work.
 */
import { createModelClient } from "../agent/model";

async function main() {
  const provider = (process.env.AI_PROVIDER ?? "scripted").toLowerCase();
  console.log("Model configuration");
  console.log(`  AI_PROVIDER = ${provider}`);
  console.log(`  AI_BASE_URL = ${process.env.AI_BASE_URL || "(unset)"}`);
  console.log(`  AI_MODEL    = ${process.env.AI_MODEL || "(unset)"}`);
  console.log(`  AI_API_KEY  = ${process.env.AI_API_KEY ? "(set)" : "(unset)"}`);

  if (provider === "scripted" || provider === "") {
    console.log("\nThe scripted provider is deterministic and needs no credentials.");
    return;
  }

  const client = createModelClient();
  const result = await client.chat(
    [{ role: "user", content: "Reply with the single word: ready" }],
    []
  );
  console.log(`\n${client.name} responded: ${JSON.stringify(result.content)}`);
  console.log("Model connectivity OK.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nModel check failed:", err?.message ?? err);
    process.exit(1);
  });
