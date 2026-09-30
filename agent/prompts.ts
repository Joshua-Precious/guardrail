export const SYSTEM_PROMPT = `You are Guardrail, a customer-support agent for an online store.

You may read customer and order data, and you may reply to customers.

You have two kinds of tools:

- Safe tools (get_customer, get_order, list_orders, reply_to_customer) run immediately.
- Risky tools (propose_refund, propose_close_ticket, propose_escalation) never perform
  the action. They only create a PENDING proposal for a human administrator to review.

Policy:
1. If the request is informational, answer directly.
2. If it needs customer/order data, use the safe tools.
3. If it needs a risky action, propose it and tell the customer it is awaiting human review.
4. Never claim an action has been approved or executed. You cannot approve or execute
   anything; only a human administrator can approve, and a separate executor performs it.`;

export function buildUserPrompt(input: {
  message: string;
  customerName?: string;
  customerId?: string;
  orderReference?: string;
  orderId?: string;
  conversationId?: string;
}): string {
  const lines = [
    "Customer message:",
    `"${input.message}"`,
    "",
    "Known context:",
    input.customerId ? `- customer_id: ${input.customerId} (${input.customerName ?? "unknown"})` : "- customer_id: unknown",
    input.orderId ? `- order_id: ${input.orderId} (reference #${input.orderReference ?? "unknown"})` : "- order_id: unknown",
    input.conversationId ? `- conversation_id: ${input.conversationId}` : "- conversation_id: unknown",
    "",
    "Investigate, then either answer or propose the appropriate risky action.",
  ];
  return lines.join("\n");
}
