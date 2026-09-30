import { api, login } from "../lib/app";
import { ADMIN, AGENT, EXECUTOR, seed, type SeedResult } from "../scripts/seed";

export interface DemoContext extends SeedResult {
  agentToken: string;
  adminToken: string;
  executorToken: string;
}

/** Seed the demo and log in as all three actors. Idempotent. */
export async function setupDemo(): Promise<DemoContext> {
  const seeded = await seed();
  const [agentToken, adminToken, executorToken] = await Promise.all([
    login("users", AGENT.email, AGENT.password),
    login("admins", ADMIN.email, ADMIN.password),
    login("users", EXECUTOR.email, EXECUTOR.password),
  ]);
  return { ...seeded, agentToken, adminToken, executorToken };
}

export async function createProposal(ctx: DemoContext) {
  return api<{ id: string; status: string }>("POST", "/api/agent_actions", {
    token: ctx.agentToken,
    body: {
      type: "refund",
      customer: ctx.customer.id,
      order: ctx.order.id,
      reasoning: "Automated test proposal",
    },
  });
}

export { api };
