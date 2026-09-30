/**
 * REST client for the executor worker.
 *
 * The executor authenticates as its own `executor` user. It can read
 * agent_actions and update them — but the transition hook only lets it move
 * `approved` rows to `executed`/`failed`, so it can never approve for itself.
 */
import { api, executeAction, login } from "../lib/app";

export interface ExecutedAction {
  id: string;
  type: "refund" | "close_ticket" | "escalate";
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  customer: string;
  order?: string;
  reasoning: string;
  result?: string;
}

export class ExecutorApi {
  constructor(private readonly token: string) {}

  static async connect(email: string, password: string): Promise<ExecutorApi> {
    return new ExecutorApi(await login("users", email, password));
  }

  async listApproved(limit = 25) {
    return api<{ docs: ExecutedAction[] }>("GET", "/api/agent_actions", {
      token: this.token,
      query: { where: JSON.stringify({ status: { eq: "approved" } }), limit },
    });
  }

  async markExecuted(id: string, result: string) {
    return executeAction(this.token, id, { result });
  }

  async markFailed(id: string, result: string) {
    return executeAction(this.token, id, { result, failed: true });
  }
}
