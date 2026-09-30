/**
 * Typed REST client for the agent worker.
 *
 * Every call goes through the real Cequre router, so the schema access rules
 * apply exactly as they would to any other API client.
 */
import { api, login } from "../lib/app";

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface Order {
  id: string;
  reference: string;
  customer: string;
  amount: number;
  status: "pending" | "paid" | "refunded" | "cancelled";
}

export interface Conversation {
  id: string;
  customer: string;
  status: "open" | "closed";
}

export interface Message {
  id: string;
  conversation: string;
  sender: "user" | "agent";
  content: string;
}

export type ActionType = "refund" | "close_ticket" | "escalate";

export interface AgentAction {
  id: string;
  type: ActionType;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  customer: string;
  order?: string;
  reasoning: string;
  result?: string;
}

export class AgentApi {
  constructor(private readonly token: string) {}

  static async connect(email: string, password: string): Promise<AgentApi> {
    return new AgentApi(await login("users", email, password));
  }

  private get auth() {
    return { token: this.token };
  }

  // --- safe tools ---------------------------------------------------------

  async getCustomer(id: string) {
    return api<Customer>("GET", `/api/customers/${id}`, this.auth);
  }

  async getOrder(id: string) {
    return api<Order>("GET", `/api/orders/${id}`, this.auth);
  }

  async findOne<T>(collection: string, where: Record<string, unknown>) {
    const res = await api<{ docs: T[] }>("GET", `/api/${collection}`, {
      token: this.token,
      query: { where: JSON.stringify(where), limit: 1 },
    });
    return res.ok ? res.data.docs[0] : undefined;
  }

  async listOrders(customerId: string) {
    return api<{ docs: Order[] }>("GET", "/api/orders", {
      token: this.token,
      query: { where: JSON.stringify({ customer: { eq: customerId } }), limit: 50 },
    });
  }

  async replyToCustomer(conversationId: string, content: string) {
    return api<Message>("POST", "/api/messages", {
      token: this.token,
      body: { conversation: conversationId, sender: "agent", content },
    });
  }

  // --- risky tools (propose only) ----------------------------------------

  async proposeAction(input: {
    type: ActionType;
    customer: string;
    order?: string;
    reasoning: string;
  }) {
    return api<AgentAction>("POST", "/api/agent_actions", {
      token: this.token,
      // status is forced to "pending" by the schema hook regardless of input.
      body: { ...input, status: "pending" },
    });
  }

  /**
   * Demo-only: deliberately attempt to approve a proposal as the agent.
   * This must be rejected with 403 by the schema access rules.
   */
  async attemptSelfApproval(actionId: string) {
    return api("PATCH", `/api/agent_actions/${actionId}`, {
      token: this.token,
      body: { status: "approved" },
    });
  }

  async getAction(actionId: string) {
    return api<AgentAction>("GET", `/api/agent_actions/${actionId}`, this.auth);
  }
}
