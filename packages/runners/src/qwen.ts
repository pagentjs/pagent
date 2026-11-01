#!/usr/bin/env node
// runner:qwen — Qwen Code through ACP: `qwen --acp`, one per agent session, in the daemon (the ACP runner,
// lib/acp-runner.ts; the contract, lib/contract.ts). As Gemini CLI's (it began as a fork of it, and keeps its tools'
// names, lib/gemini-tools.ts): the runner's own record is the history, the timeline and the token use; no terminal in
// the app. Its lists of steps come as ACP plans.
//
// What it adds per agent: the "auto-edit" mode (edits without asking; anything else asks, as a card in the app).
// Versions: Qwen Code 0.19.11 (ACP protocol 1).
import { runAcp } from "./lib/acp-runner.ts";
import { geminiTool } from "./lib/gemini-tools.ts";

await runAcp({
  id: "qwen",
  title: "Qwen Code",
  classify: geminiTool,
  mode: "auto-edit",
  agent: (input) => ({ command: process.env.QWEN_BIN ?? "qwen", args: ["--acp", ...(typeof input.options?.model === "string" ? ["--model", input.options.model] : [])] }),
  resume: (session) => `qwen --resume ${session}`,
});
