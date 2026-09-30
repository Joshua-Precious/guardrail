import { CequreError, CequreModule } from "cequre-ts";
import type { Collections } from "../_generated/server";

export const routesModule = new CequreModule<Collections>();

// Health check for uptime probes.
routesModule.get("/health", () => ({ status: "ok" }));

const APPROVER_ROLES = ["admin", "super", "editor"];

/**
 * Business logic for the human-in-the-loop boundary.
 *
 * Authorization lives in the schema access rules (see
 * cequre/collections/agent_actions.cequre). These hooks enforce the
 * state-machine invariants a role gate alone cannot express:
 *
 *   pending  --approver-->  approved | rejected
 *   approved --executor-->  executed | failed
 */
routesModule.hooks("agent_actions", {
  beforeCreate: (ctx) => {
    const data = ctx.data as any;
    // A proposal can never be born anything but pending, and can never carry a
    // executor-supplied result, whatever the payload claims.
    data.status = "pending";
    delete data.result;
    return data;
  },

  beforeUpdate: async (ctx) => {
    const data = ctx.data as any;
    const role = ctx.user?.role ?? "";
    const isApprover = APPROVER_ROLES.includes(role);
    const isExecutor = role === "executor";

    // Executors may only report an outcome; they cannot rewrite a proposal.
    if (isExecutor) {
      for (const key of Object.keys(data)) {
        if (key !== "status" && key !== "result") delete data[key];
      }
    }

    const params = (ctx as { params?: { id?: string } }).params;
    const id =
      params?.id ??
      new URL(ctx.request.url).pathname.split("/").filter(Boolean).pop();
    const current = id ? await ctx.cequre.findById("agent_actions", id) : null;

    const from = (current as { status?: string } | null)?.status;
    const to = data.status as string | undefined;

    // Updating something other than status (e.g. recording a result) is allowed.
    if (to === undefined) return data;

    if (to === from) {
      // Idempotent no-ops are fine, except replaying a finished execution.
      if (isExecutor && (to === "executed" || to === "failed")) {
        throw CequreError.Forbidden(
          `agent_actions ${id} is already "${to}"; refusing to re-run it`
        );
      }
      return data;
    }

    if (isApprover && from === "pending" && (to === "approved" || to === "rejected")) {
      return data;
    }
    if (isExecutor && from === "approved" && (to === "executed" || to === "failed")) {
      return data;
    }

    throw CequreError.Forbidden(
      `Illegal agent_actions transition "${from ?? "unknown"}" -> "${to}" for role "${role}"`
    );
  },
});

// --- Intent-revealing approval endpoints --------------------------------
//
// These are thin aliases over the collection's PATCH endpoint. Crucially they
// re-enter the *real* request pipeline with the caller's own credentials, so
// the schema access rules and the transition hooks above still decide the
// outcome. An agent calling /approve is rejected exactly as a raw PATCH would
// be; the endpoint cannot be used to bypass the boundary.

type TransitionStatus = "approved" | "rejected" | "executed" | "failed";

function transition(status: TransitionStatus, extra: Record<string, unknown> = {}) {
  return async (ctx: any) => {
    const authorization = ctx.request.headers.get("authorization");
    const target = new URL(
      `/api/agent_actions/${ctx.params.id}`,
      new URL(ctx.request.url).origin
    );

    return ctx.cequre.fetch(
      new Request(target, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify({ status, ...extra }),
      })
    );
  };
}

routesModule.post("/api/agent_actions/:id/approve", transition("approved"));
routesModule.post("/api/agent_actions/:id/reject", transition("rejected"));

routesModule.post("/api/agent_actions/:id/execute", async (ctx: any) => {
  const body = await ctx.request.json().catch(() => ({}));
  const requested = body?.status === "failed" ? "failed" : "executed";
  return transition(requested, body?.result ? { result: body.result } : {})(ctx);
});
