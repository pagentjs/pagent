#!/usr/bin/env node
// A small scripted ACP agent, for tests of the ACP runner (packages/runners/src/lib/acp-runner.ts) where a recording
// (acp-replay.ts) cannot say it: a session the agent no longer has, a turn that waits to be cancelled, a background
// process it leaves running. Run in place of a harness's CLI (QWEN_BIN, OPENCODE_BIN, GEMINI_BIN point here).
// $FAKE_ACP_DIR keeps what it knows: the sessions it has (sessions, one id a line), the pid of a process it started
// (child.pid). A prompt's text says what it does:
//   !wait    the turn goes on until it is cancelled (session/cancel), then ends "cancelled"
//   !child   it starts a long `sleep` (in its own process group, as a shell tool's background job), notes its pid
//   other    one text chunk "ok: <text>", then the end, with its tokens
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.FAKE_ACP_DIR!;
const sessionsFile = join(dir, "sessions");
const has = (id: string) => existsSync(sessionsFile) && readFileSync(sessionsFile, "utf8").split("\n").includes(id);
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const answer = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const update = (sessionId: string, u: unknown) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
let cancelled = null as (() => void) | null;

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    continue;
  }
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      answer(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, agentInfo: { name: "fake-acp" } });
      break;
    case "session/new": {
      const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      appendFileSync(sessionsFile, id + "\n");
      answer(m.id, { sessionId: id });
      break;
    }
    case "session/resume":
    case "session/load":
      if (has(p.sessionId)) answer(m.id, {});
      else fail(m.id, -32002, `Session not found: ${p.sessionId}`);
      break;
    case "session/set_mode":
      answer(m.id, {});
      break;
    case "session/cancel":
      cancelled?.();
      break;
    case "session/prompt": {
      const text = String(p.prompt?.[0]?.text ?? "");
      if (text.includes("!wait")) {
        void new Promise<void>((r) => (cancelled = r)).then(() => answer(m.id, { stopReason: "cancelled" }));
        break;
      }
      if (text.includes("!child")) {
        const child = spawn("sleep", ["300"], { stdio: "ignore" });
        writeFileSync(join(dir, "child.pid"), String(child.pid));
      }
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ok: ${text.replace(/^<pagent-instructions>[\s\S]*?<\/pagent-instructions>\n*/, "")}` } });
      answer(m.id, { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
      break;
    }
    default:
      if (m.id !== undefined && m.method) fail(m.id, -32601, `no ${m.method}`);
  }
}
