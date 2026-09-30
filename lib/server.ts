/**
 * Starts a real HTTP server around the app's request pipeline.
 *
 * `cequre/index.ts` already does this for the dev/prod entrypoint; this helper
 * is for worker/test processes (e.g. exercising the SSE endpoint) and binds an
 * ephemeral port by default.
 */
import { app, ensureReady } from "./app";

export interface HttpServer {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

export async function startHttpServer(port = 0): Promise<HttpServer> {
  await ensureReady();
  const server = Bun.serve({
    port,
    fetch: (request) => app.fetch(request),
  });
  const boundPort = server.port ?? port;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    stop: async () => {
      await server.stop(true);
    },
  };
}
