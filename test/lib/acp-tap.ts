#!/usr/bin/env node
// Records an ACP agent's conversation with its client, for fixtures (test/fixtures/acp/): runs the real agent
// ($TAP_REAL with these arguments) in its place and writes every JSON-RPC message, each way, to $TAP_LOG
// ({ dir: ">" from the client | "<" from the agent, m }). `export <id>` (opencode's own record of a session) is run
// and its output kept too ({ export }). scripts/record-acp.ts drives it.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const real = process.env.TAP_REAL!;
const log = process.env.TAP_LOG!;
const args = process.argv.slice(2);
const note = (o: unknown) => appendFileSync(log, JSON.stringify(o) + "\n");

if (args[0] === "export") {
  const r = spawnSync(real, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  note({ export: args[1], stdout: r.stdout });
  process.stdout.write(r.stdout);
  process.exit(r.status ?? 1);
}

const child = spawn(real, args, { stdio: ["pipe", "pipe", "inherit"] });
const lines = (dir: ">" | "<", write: (s: string) => void) => {
  let buf = "";
  return (d: Buffer) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        note({ t: Date.now(), dir, m: JSON.parse(line) });
      } catch {}
      write(line + "\n");
    }
  };
};
process.stdin.on("data", lines(">", (s) => child.stdin.write(s)));
process.stdin.on("end", () => child.stdin.end());
child.stdout.on("data", lines("<", (s) => process.stdout.write(s)));
child.on("close", (code) => process.exit(code ?? 0));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => child.kill(sig));
