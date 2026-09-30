/**
 * Smoke test for the Cequre MCP server wiring.
 *
 * Spawns `cequre mcp` over stdio, completes the JSON-RPC handshake, and checks
 * that the development tool surface is advertised.
 */
import { describe, expect, test } from "bun:test";

const timeout = (ms: number) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("MCP timed out")), ms));

async function queryMcp(messages: unknown[]): Promise<any[]> {
  const proc = Bun.spawn(["cequre", "mcp", "--workspace", "."], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });

  const responses: any[] = [];
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readLoop = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          /* non-JSON line */
        }
      }
    }
  })();

  for (const message of messages) {
    proc.stdin.write(JSON.stringify(message) + "\n");
  }
  await proc.stdin.flush();

  const waitFor = (id: number) =>
    new Promise<any>((resolve) => {
      const check = () => {
        const hit = responses.find((r) => r.id === id);
        if (hit) resolve(hit);
        else setTimeout(check, 25);
      };
      check();
    });

  const result = await Promise.race([waitFor(2), timeout(15_000)]);

  proc.kill();
  await readLoop.catch(() => {});
  return [result];
}

describe("Cequre MCP server", () => {
  test("responds to initialize and lists its tools", async () => {
    const [toolsResponse] = await queryMcp([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "guardrail-test", version: "1.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    const names = (toolsResponse.result.tools ?? []).map((tool: any) => tool.name);
    expect(names).toContain("cequre_schema");
    expect(names).toContain("cequre_security");
    expect(names).toContain("cequre_database");
  }, 30_000);
});
