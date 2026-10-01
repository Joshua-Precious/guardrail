/**
 * Measures the two numbers worth quoting in a post: how long the backend takes
 * to come up, and how much memory it holds while sitting idle.
 *
 *   bun run measure
 *   bun run measure --runs 5 --port 3457
 *
 * Boot time is spawn → `GET /health` returning 200. That includes Bun starting,
 * the Postgres adapter connecting, the schema syncing and the routes being built
 * — i.e. everything a cold `bun run cequre/index.ts` actually does.
 *
 * Idle RSS is read from the server process 5s after it answered /health, with no
 * requests in flight (Linux: /proc/<pid>/status, elsewhere: `ps -o rss=`). The
 * bare-Bun baseline is printed alongside it so the number is interpretable
 * rather than impressive-sounding.
 */
import { spawn, type ChildProcess } from "node:child_process";

const ENTRY = "cequre/index.ts";
const DEFAULT_PORT = 3457;
const DEFAULT_RUNS = 3;
const IDLE_MS = 5_000;
const BOOT_TIMEOUT_MS = 30_000;
const POLL_MS = 15;

interface Measurement {
  bootMs: number;
  idleMb: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Resident set size of a live process, in MB. */
async function rssMb(pid: number): Promise<number> {
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    const line = status.split("\n").find((l) => l.startsWith("VmRSS:"));
    if (line) return Number(line.split(/\s+/)[1]) / 1024;
  } catch {
    // Not Linux — fall through to ps.
  }
  const ps = spawn("ps", ["-o", "rss=", "-p", String(pid)]);
  const chunks: string[] = [];
  for await (const chunk of ps.stdout) chunks.push(String(chunk));
  return Number(chunks.join("").trim()) / 1024;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) return;
    await sleep(50);
  }
  child.kill("SIGKILL");
  await sleep(100);
}

/** Spawn the server and time it until /health answers. */
async function boot(port: number): Promise<{ ms: number; child: ChildProcess }> {
  const startedAt = performance.now();
  const child = spawn("bun", ["run", ENTRY], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: string[] = [];
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  const deadline = startedAt + BOOT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${logs.join("")}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return { ms: performance.now() - startedAt, child };
    } catch {
      // Not listening yet.
    }
    await sleep(POLL_MS);
  }

  await stop(child);
  throw new Error(`no /health response within ${BOOT_TIMEOUT_MS}ms:\n${logs.join("")}`);
}

async function measureOnce(port: number): Promise<Measurement> {
  const { ms, child } = await boot(port);
  await sleep(IDLE_MS);
  const idleMb = await rssMb(child.pid!);
  await stop(child);
  return { bootMs: ms, idleMb };
}

/** What the same runtime costs with no server in it, for context. */
async function bunBaselineMb(): Promise<number> {
  const child = spawn("bun", ["-e", `setTimeout(() => {}, ${IDLE_MS})`], { stdio: "ignore" });
  await sleep(IDLE_MS - 1_000);
  const mb = await rssMb(child.pid!);
  child.kill("SIGKILL");
  return mb;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatBoot(ms: number): string {
  return ms < 1_000 ? `${ms.toFixed(0)} ms` : `${(ms / 1_000).toFixed(2)} s`;
}

async function main() {
  const runs = Number(argValue("--runs") ?? process.env.MEASURE_RUNS ?? DEFAULT_RUNS);
  const basePort = Number(argValue("--port") ?? process.env.MEASURE_PORT ?? DEFAULT_PORT);

  console.log(`Guardrail boot/idle measurement — ${runs} run(s), ${ENTRY}\n`);
  console.log("  run   boot (spawn → /health 200)   idle RSS (5s, no requests)");

  const results: Measurement[] = [];
  for (let run = 1; run <= runs; run++) {
    const m = await measureOnce(basePort + run);
    results.push(m);
    console.log(
      `  ${String(run).padStart(3)}   ${formatBoot(m.bootMs).padStart(24)}   ${(m.idleMb.toFixed(1) + " MB").padStart(25)}`
    );
  }

  const bootMs = median(results.map((r) => r.bootMs));
  const idleMb = median(results.map((r) => r.idleMb));
  const baseline = await bunBaselineMb();

  console.log(`\n  median boot:        ${formatBoot(bootMs)}`);
  console.log(`  median idle RSS:    ${idleMb.toFixed(1)} MB`);
  console.log(`  bare Bun, no server: ${baseline.toFixed(1)} MB (this runtime's floor)`);
  console.log(`  bun ${Bun.version} on ${process.platform}/${process.arch}\n`);
  console.log(`Claimable line: "boots in ${formatBoot(bootMs)} and idles at ${idleMb.toFixed(0)} MB"`);
  console.log("Single machine, local Postgres, warm caches — quote it exactly like that.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nMeasurement failed:", err?.message ?? err);
    process.exit(1);
  });
