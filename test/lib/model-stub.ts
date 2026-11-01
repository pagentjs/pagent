#!/usr/bin/env node
// A stand-in for a model API, for running a real harness CLI with no model and no account: OpenAI-compatible chat
// completions (opencode with an openai-compatible provider, qwen) and Gemini's generateContent (Gemini CLI), both
// streamed. It answers from a script written in the person's message, one step per line starting with "!" (as the fake
// runner does), so a recorded session is the same every time:
//   !sh <command>          a call to the harness's shell tool (whatever it names it: bash, run_shell_command, …)
//   !write <path> <text>   a call to its tool that writes a file
//   !read <path>           a call to its tool that reads a file
//   !todo <a> | <b> | <c>  a call to its to-do tool: the first step under way, the rest to do (then, once more, all done)
//   !say <text>            the reply's text (after the calls)
// One call per request, in order; once every call has its result, the reply: the !say lines, else "echo: <message>".
// Any other request (a title for the session, a JSON check of who speaks next) gets a short plain answer. Token counts
// are made up from the request's size, so they are the same each time.
//
// node test/lib/model-stub.ts --port 5071 [--log requests.jsonl]
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Call = { tool: string; args: Record<string, unknown> };
type Step = { kind: "sh" | "write" | "read" | "todo" | "todo-done"; arg: string };

const flag = (f: string) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : undefined);

/** The steps of a message, and what it says at the end. */
function scriptOf(message: string): { steps: Step[]; say: string[] } {
  const steps: Step[] = [];
  const say: string[] = [];
  for (const line of message.split("\n").map((l) => l.trim())) {
    const [, step, arg = ""] = /^!(\w+)\s*([\s\S]*)$/.exec(line) ?? [];
    if (step === "say") say.push(arg);
    else if (step === "sh" || step === "write" || step === "read") steps.push({ kind: step, arg });
    else if (step === "todo") steps.push({ kind: "todo", arg }, { kind: "todo-done", arg });
  }
  return { steps, say };
}

type Tool = { name: string; schema: any };
const pick = (tools: Tool[], names: string[]) => names.map((n) => tools.find((t) => t.name.toLowerCase() === n.toLowerCase())).find(Boolean);
const props = (t: Tool) => (t.schema?.properties ?? {}) as Record<string, any>;

/** A step as a call to the harness's own tool for it, its arguments shaped by that tool's schema. */
function callOf(step: Step, tools: Tool[]): Call | null {
  if (step.kind === "sh") {
    const t = pick(tools, ["bash", "run_shell_command", "shell", "exec_command"]);
    if (!t) return null;
    const p = props(t);
    return { tool: t.name, args: { command: step.arg, ...("description" in p ? { description: "Run a command" } : {}), ...("is_background" in p ? { is_background: false } : {}) } };
  }
  if (step.kind === "write") {
    const t = pick(tools, ["write", "write_file"]);
    if (!t) return null;
    const [, path, text = ""] = /^(\S+)\s*([\s\S]*)$/.exec(step.arg) ?? [];
    const key = "filePath" in props(t) ? "filePath" : "file_path" in props(t) ? "file_path" : "path";
    return { tool: t.name, args: { [key]: path, content: text } };
  }
  if (step.kind === "read") {
    const t = pick(tools, ["read", "read_file"]);
    if (!t) return null;
    const key = "filePath" in props(t) ? "filePath" : "file_path" in props(t) ? "file_path" : "absolute_path" in props(t) ? "absolute_path" : "path";
    return { tool: t.name, args: { [key]: step.arg } };
  }
  const t = pick(tools, ["todowrite", "write_todos", "todo_write"]);
  if (!t) return null;
  const item = props(t).todos?.items?.properties ?? {};
  const textKey = "content" in item ? "content" : "description" in item ? "description" : "text";
  const todos = step.arg.split("|").map((s, i) => ({
    ...("id" in item ? { id: String(i + 1) } : {}),
    [textKey]: s.trim(),
    status: step.kind === "todo-done" ? "completed" : i === 0 ? "in_progress" : "pending",
    ...("priority" in item ? { priority: "medium" } : {}),
  }));
  return { tool: t.name, args: { todos } };
}

/** What to answer: the next call of the script, or its reply. done: how many calls got their result since the message. */
function answer(message: string, done: number, tools: Tool[]): { call?: Call; text?: string } {
  const { steps, say } = scriptOf(message);
  const calls = steps.map((s) => callOf(s, tools)).filter((c): c is Call => !!c);
  if (done < calls.length) return { call: calls[done] };
  return { text: say.length ? say.join("\n\n") : steps.length ? `done: ${calls.length} calls` : `echo: ${message.trim()}` };
}

const tokens = (v: unknown) => Math.ceil(JSON.stringify(v ?? "").length / 4);
let seq = 0;

// ---------------------------------------------------------------- OpenAI-compatible

// The person's words: the message's text, or its last text part (a harness may put its reminders before them).
const textOf = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? (c.filter((p) => typeof p === "string" || typeof p?.text === "string").map((p) => (typeof p === "string" ? p : p.text)).at(-1) ?? "") : "");

function openai(body: any, res: ServerResponse) {
  const messages: any[] = body.messages ?? [];
  const tools: Tool[] = (body.tools ?? []).map((t: any) => ({ name: t.function?.name, schema: t.function?.parameters }));
  let u = messages.length - 1;
  while (u >= 0 && messages[u].role !== "user") u--;
  const message = u >= 0 ? textOf(messages[u].content) : "";
  const done = messages.slice(u + 1).filter((m) => m.role === "tool").length;
  const a = tools.length ? answer(message, done, tools) : { text: /title/i.test(JSON.stringify(messages[0] ?? "")) ? "Stand-in session" : `echo: ${message.trim().slice(0, 200)}` };
  const id = `chatcmpl-stub-${++seq}`;
  const usage = { prompt_tokens: tokens(messages), completion_tokens: tokens(a), total_tokens: tokens(messages) + tokens(a), prompt_tokens_details: { cached_tokens: 0 } };
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? "stand-in" };
  if (!body.stream) {
    const msg = a.call ? { role: "assistant", content: null, tool_calls: [{ id: `call_${seq}`, type: "function", function: { name: a.call.tool, arguments: JSON.stringify(a.call.args) } }] } : { role: "assistant", content: a.text };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: msg, finish_reason: a.call ? "tool_calls" : "stop" }], usage }));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  if (a.call) send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${seq}`, type: "function", function: { name: a.call.tool, arguments: JSON.stringify(a.call.args) } }] }, finish_reason: null }] });
  else for (const piece of (a.text ?? "").match(/.{1,24}/gs) ?? []) send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: a.call ? "tool_calls" : "stop" }] });
  send({ ...base, choices: [], usage });
  res.end("data: [DONE]\n\n");
}

// ---------------------------------------------------------------- Gemini

function gemini(model: string, stream: boolean, body: any, res: ServerResponse) {
  const contents: any[] = body.contents ?? [];
  const tools: Tool[] = (body.tools ?? []).flatMap((t: any) => t.functionDeclarations ?? []).map((f: any) => ({ name: f.name, schema: f.parametersJsonSchema ?? f.parameters }));
  let u = contents.length - 1;
  const isMessage = (c: any) => c.role === "user" && (c.parts ?? []).some((p: any) => typeof p.text === "string") && !(c.parts ?? []).some((p: any) => p.functionResponse);
  while (u >= 0 && !isMessage(contents[u])) u--;
  // The person's words are the last text of that turn (Gemini CLI puts its session context before them).
  const message = u >= 0 ? (contents[u].parts.filter((p: any) => typeof p.text === "string").at(-1)?.text ?? "") : "";
  const done = contents.slice(u + 1).flatMap((c) => c.parts ?? []).filter((p: any) => p.functionResponse).length;
  const json = body.generationConfig?.responseMimeType === "application/json" || body.generationConfig?.responseJsonSchema || body.generationConfig?.responseSchema;
  const a = json ? { text: JSON.stringify({ next_speaker: "user", reasoning: "stand-in", model_choice: "flash", complexity_score: 1 }) } : tools.length ? answer(message, done, tools) : { text: `echo: ${message.trim().slice(0, 200)}` };
  const part = a.call ? { functionCall: { name: a.call.tool, args: a.call.args } } : { text: a.text };
  const usageMetadata = { promptTokenCount: tokens(contents), candidatesTokenCount: tokens(a), totalTokenCount: tokens(contents) + tokens(a) };
  const reply = { candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }], usageMetadata, modelVersion: model, responseId: `stub-${++seq}` };
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(reply));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify(reply)}\r\n\r\n`);
}

// ---------------------------------------------------------------- server

async function readBody(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

export function startStub(port: number, log?: string) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const body = req.method === "POST" ? await readBody(req) : {};
    if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), method: req.method, path: url.pathname + url.search, body }) + "\n");
    const g = /\/models\/([^/:]+):(streamGenerateContent|generateContent|countTokens|embedContent)$/.exec(url.pathname);
    if (g?.[2] === "countTokens") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ totalTokens: tokens(body.contents) }));
    if (g?.[2] === "embedContent") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embedding: { values: [0, 0, 0] } }));
    if (g) return gemini(g[1], g[2] === "streamGenerateContent", body, res);
    if (url.pathname.endsWith("/chat/completions")) return openai(body, res);
    if (url.pathname.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "stand-in", object: "model", owned_by: "stub" }], models: [{ name: "models/stand-in" }] }));
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `the stand-in has no ${url.pathname}` } }));
  });
  return new Promise<typeof server>((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(flag("--port") ?? 5071);
  await startStub(port, flag("--log"));
  console.log(`stand-in model API on http://127.0.0.1:${port}`);
}
