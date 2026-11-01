#!/usr/bin/env node
// runner:opencode — opencode (opencode.ai) through ACP: `opencode acp`, one per agent session, in the daemon (the ACP
// runner, lib/acp-runner.ts; the contract, lib/contract.ts). opencode is a server with sessions of its own: its ACP
// agent serves the same HTTP API its TUI talks to, so the agent's terminal is `opencode attach` on that server and
// that session, one more client of it, as Codex's TUI is of its thread. Its own export (`opencode export <id>`) is the
// history and the timeline: each request with its tokens and cost, and what was typed in its TUI too.
//
// What it adds per agent, besides what every ACP harness gets (identity, instructions, declared MCP servers):
//   permissions: edits without asking, `pagent` and the git commands an agent commits with without asking, any other
//     command, a web fetch or an MCP tool asks (as a card in the app): OPENCODE_PERMISSION, layered over the user's;
//   skills declared for the agent replace the user's (opencode's external and Claude Code skill folders off).
// Versions: opencode 1.19.3 (ACP protocol 1).
import { existsSync } from "node:fs";
import { runAcp, type Input } from "./lib/acp-runner.ts";
import { exportSession, historyOfExport, opencodePermission, opencodeTool, trajectoryOfExport, usageOfExport } from "./lib/opencode-export.ts";
import { readRecord, recordFile, usageOf } from "./lib/acp-record.ts";

const bin = () => process.env.OPENCODE_BIN ?? "opencode";

/** The instructions pagent put at the head of a session's first message, left out of what the person said. */
const strip = (text: string) => text.replace(/^<pagent-instructions>[\s\S]*?<\/pagent-instructions>\n*/, "");

const permission = (input: Input) => opencodePermission(Array.isArray((input.options as { allow?: unknown })?.allow) ? (input.options as { allow: string[] }).allow : []);

await runAcp({
  id: "opencode",
  title: "opencode",
  classify: opencodeTool,
  serves: true,
  agent: (input, port) => ({
    command: bin(),
    args: ["acp", "--cwd", input.cwd, ...(port ? ["--port", String(port), "--hostname", "127.0.0.1"] : [])],
    env: {
      OPENCODE_PERMISSION: JSON.stringify(permission(input)),
      ...(input.skills ? { OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" } : {}),
      ...(typeof input.options?.model === "string" ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: input.options.model }) } : {}),
    },
  }),
  attach: (input) =>
    input.endpoint
      ? { command: bin(), args: ["attach", input.endpoint, "--session", input.thread, "--dir", input.cwd], cwd: input.cwd, ...(input.env ? { env: input.env } : {}) }
      : null,
  resume: (session) => `opencode --session ${session}`,
  // What changed in the session is what the runner kept of it (its record: every update of the agent's, in the app's
  // turns or its TUI's, while its session runs), not opencode's database: that is every session of every opencode on
  // this machine, so stamping on it would read every agent's export again at any opencode activity anywhere.
  native: {
    async history(input, session) {
      const e = await exportSession(bin(), session, input.cwd);
      if (!e) return null;
      const file = recordFile(input.stateDir, session);
      return { messages: historyOfExport(e, strip), ...(existsSync(file) ? { file } : {}) };
    },
    async trajectory(input, session) {
      const e = await exportSession(bin(), session, input.cwd);
      if (!e) return null;
      const file = recordFile(input.stateDir, session);
      return { records: trajectoryOfExport(e, strip), ...(existsSync(file) ? { file } : {}) };
    },
    async usage(input, session) {
      const e = await exportSession(bin(), session, input.cwd);
      const u = e && usageOfExport(e);
      if (!u) return null;
      // The window: what its ACP agent last said (usage_update), as its export does not.
      u.window = usageOf(readRecord(recordFile(input.stateDir, session)))?.window ?? null;
      return u;
    },
  },
});
