import { createCequre } from "../cequre/_generated/server";
import { PostgresAdapter, defaultSecurity, defaultMonitoring } from "cequre-ts";
import { routesModule } from "../cequre/routes";

/**
 * The same composition root as cequre/index.ts, minus `app.start()`.
 *
 * Scripts, workers, and tests drive the real request pipeline through
 * `app.fetch()` after `ensureReady()` connects the adapter, syncs the schema,
 * and builds routes — no HTTP port required.
 */
export const app = createCequre({
  adapter: new PostgresAdapter(process.env.DATABASE_URL!),
  plugins: [defaultSecurity(), defaultMonitoring()],
}).use(routesModule);

let initOnce: Promise<void> | null = null;

export function ensureReady(): Promise<void> {
  initOnce ??= app.init();
  return initOnce;
}

const BASE_URL = process.env.API_BASE_URL ?? "http://localhost";

export interface ApiResponse<T = any> {
  status: number;
  ok: boolean;
  data: T;
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
}

/** Minimal JSON client that speaks to the app through its real router. */
export async function api<T = any>(
  method: string,
  path: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  await ensureReady();

  const url = new URL(path.startsWith("/") ? path : `/${path}`, BASE_URL);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

  const response = await app.fetch(
    new Request(url.toString(), {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  );

  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }

  return { status: response.status, ok: response.ok, data };
}

export async function login(
  collection: string,
  email: string,
  password: string
): Promise<string> {
  const res = await api<{ accessToken?: string }>("POST", `/api/${collection}/login`, {
    body: { email, password },
  });
  if (!res.ok || !res.data?.accessToken) {
    throw new Error(
      `Login failed for ${email} in ${collection} (${res.status}): ${JSON.stringify(res.data)}`
    );
  }
  return res.data.accessToken;
}

export async function register(
  collection: string,
  body: Record<string, unknown>,
  token?: string
): Promise<ApiResponse> {
  return api("POST", `/api/${collection}/register`, { body, token });
}

// --- Semantic action endpoints -------------------------------------------
// Thin aliases over the collection PATCH route. They re-enter the real
// pipeline, so the schema access rules still decide the outcome.

export function approveAction(token: string, id: string) {
  return api("POST", `/api/agent_actions/${id}/approve`, { token });
}

export function rejectAction(token: string, id: string) {
  return api("POST", `/api/agent_actions/${id}/reject`, { token });
}

export function executeAction(
  token: string,
  id: string,
  options: { result?: string; failed?: boolean } = {}
) {
  return api("POST", `/api/agent_actions/${id}/execute`, {
    token,
    body: { result: options.result, status: options.failed ? "failed" : "executed" },
  });
}
