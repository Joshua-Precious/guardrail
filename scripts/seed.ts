/**
 * Idempotent demo seed.
 *
 * Creates the bootstrap admin, the agent/executor service accounts, a demo
 * customer + conversation, and order #1024 (the double-charge scenario).
 * Safe to re-run: existing rows are reused instead of duplicated.
 *
 * Run with: bun run seed     (also importable as `seed()` from tests)
 */
import { api, ensureReady, login, register } from "../lib/app";

export const ADMIN = {
  name: "Guardrail Admin",
  email: process.env.ADMIN_EMAIL ?? "admin@guardrail.dev",
  password: process.env.ADMIN_PASSWORD ?? "Passw0rd!123",
  role: "admin",
};
export const AGENT = {
  name: "Support Agent",
  email: process.env.AGENT_EMAIL ?? "agent@guardrail.dev",
  password: process.env.AGENT_PASSWORD ?? "Passw0rd!123",
  role: "agent",
};
export const EXECUTOR = {
  name: "Action Executor",
  email: process.env.EXECUTOR_EMAIL ?? "executor@guardrail.dev",
  password: process.env.EXECUTOR_PASSWORD ?? "Passw0rd!123",
  role: "executor",
};
export const CUSTOMER = {
  name: "John Doe",
  email: process.env.CUSTOMER_EMAIL ?? "john.doe@example.com",
};
export const ORDER_REFERENCE = "1024";

export interface SeedResult {
  adminToken: string;
  customer: any;
  order: any;
  conversation: any;
}

type Logger = (message: string) => void;

async function bootstrapAdmin(log: Logger): Promise<string> {
  // The admins collection accepts the very first registration without a token
  // (empty-collection bootstrap); afterwards an admin token is required.
  const created = await register("admins", ADMIN);
  if (created.ok) {
    log(`  + admin account created (${ADMIN.email})`);
    return created.data.accessToken as string;
  }
  const token = await login("admins", ADMIN.email, ADMIN.password);
  log(`  = admin account already exists (${ADMIN.email})`);
  return token;
}

async function ensureUser(
  token: string,
  account: { name: string; email: string; password: string; role: string },
  log: Logger
): Promise<void> {
  const existing = await api("GET", "/api/users", {
    token,
    query: { where: JSON.stringify({ email: { eq: account.email } }) },
  });
  if (existing.ok && (existing.data.docs?.length ?? 0) > 0) {
    log(`  = ${account.role} account already exists (${account.email})`);
    return;
  }
  const created = await register("users", account, token);
  if (!created.ok) {
    throw new Error(`Failed to create ${account.role}: ${created.status} ${JSON.stringify(created.data)}`);
  }
  log(`  + ${account.role} account created (${account.email})`);
}

async function findOne(token: string, collection: string, where: Record<string, unknown>) {
  const res = await api<{ docs: any[] }>("GET", `/api/${collection}`, {
    token,
    query: { where: JSON.stringify(where), limit: 1 },
  });
  if (!res.ok) throw new Error(`Failed to query ${collection}: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.docs[0];
}

async function create(token: string, collection: string, body: Record<string, unknown>) {
  const res = await api("POST", `/api/${collection}`, { token, body });
  if (!res.ok) throw new Error(`Failed to create ${collection}: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

export async function seed(options: { log?: Logger } = {}): Promise<SeedResult> {
  const log: Logger = options.log ?? (() => {});
  await ensureReady();
  log("Seeding Guardrail...");

  const adminToken = await bootstrapAdmin(log);
  await ensureUser(adminToken, AGENT, log);
  await ensureUser(adminToken, EXECUTOR, log);

  let customer = await findOne(adminToken, "customers", { email: { eq: CUSTOMER.email } });
  if (!customer) {
    customer = await create(adminToken, "customers", CUSTOMER);
    log(`  + customer created (${CUSTOMER.name})`);
  } else {
    log(`  = customer already exists (${CUSTOMER.name})`);
  }

  let order = await findOne(adminToken, "orders", { reference: { eq: ORDER_REFERENCE } });
  if (!order) {
    order = await create(adminToken, "orders", {
      reference: ORDER_REFERENCE,
      customer: customer.id,
      amount: 45000,
      status: "paid",
    });
    log(`  + order #${ORDER_REFERENCE} created (NGN 45,000, paid)`);
  } else {
    log(`  = order #${ORDER_REFERENCE} already exists`);
  }

  let conversation = await findOne(adminToken, "conversations", { customer: { eq: customer.id } });
  if (!conversation) {
    conversation = await create(adminToken, "conversations", {
      customer: customer.id,
      status: "open",
    });
    log("  + conversation created");
  } else {
    log("  = conversation already exists");
  }

  const firstMessage = await findOne(adminToken, "messages", { conversation: { eq: conversation.id } });
  if (!firstMessage) {
    await create(adminToken, "messages", {
      conversation: conversation.id,
      sender: "user",
      content: "I was charged twice for order #1024. Please refund me.",
    });
    log("  + customer message created");
  } else {
    log("  = customer message already exists");
  }

  log("Seed complete.");
  return { adminToken, customer, order, conversation };
}

async function main() {
  const result = await seed({ log: console.log });
  console.log(`\n  customer id    ${result.customer.id}`);
  console.log(`  order id       ${result.order.id}`);
  console.log(`  conversation   ${result.conversation.id}`);
  console.log(`  agent login    ${AGENT.email} / ${AGENT.password}`);
  console.log(`  executor login ${EXECUTOR.email} / ${EXECUTOR.password}`);
  console.log(`  admin login    ${ADMIN.email} / ${ADMIN.password}`);
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\nSeed failed:", err?.message ?? err);
      process.exit(1);
    });
}
