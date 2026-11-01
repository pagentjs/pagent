#!/usr/bin/env node
// runner:gemini — Gemini CLI through ACP: `gemini --acp`, one per agent session, in the daemon (the ACP runner,
// lib/acp-runner.ts; the contract, lib/contract.ts). Everything is the ACP runner's: the history, the timeline and the
// token use are what it kept of each session (Gemini CLI's own chat files are a log of rewrites, not read here). Its TUI
// cannot attach to a session another process has open, so a Gemini agent has no terminal in the app (can.terminal).
//
// What it adds per agent: the "autoEdit" mode (edits without asking; any other tool asks, as a card in the app), and a
// policy of its own (<stateDir>/gemini-policy.toml, --policy, on top of the user's) that lets `pagent` commands run
// without asking. (--allowed-tools does that too, but then every other command is denied instead of asked.)
// Versions: Gemini CLI 0.60.0 (ACP protocol 1).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAcp } from "./lib/acp-runner.ts";
import { geminiTool } from "./lib/gemini-tools.ts";

const POLICY = `# pagent: an agent reaches its app with \`pagent\` commands, which never ask.
[[rule]]
toolName = "run_shell_command"
commandPrefix = "pagent"
decision = "allow"
priority = 900
`;

await runAcp({
  id: "gemini",
  title: "Gemini CLI",
  classify: geminiTool,
  mode: "autoEdit",
  agent: (input) => {
    mkdirSync(input.stateDir, { recursive: true });
    const policy = join(input.stateDir, "gemini-policy.toml");
    writeFileSync(policy, POLICY);
    return { command: process.env.GEMINI_BIN ?? "gemini", args: ["--acp", "--policy", policy, ...(typeof input.options?.model === "string" ? ["--model", input.options.model] : [])] };
  },
});
