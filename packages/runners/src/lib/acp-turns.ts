// What happens in an ACP session (its session/update notifications), as the app shows it: live, as UIMessageChunks; and
// afterwards, from what the runner kept of it (its record: acp-record.ts), as UIMessages and as a trajectory. One state
// machine (Reply) for both, so the history is what the conversation showed.
//   agent_message_chunk → text, agent_thought_chunk → reasoning, tool_call / tool_call_update → a dynamic tool (its
//   name as the harness names it, what it does as the runner's table says: toolMetadata), plan → its list of steps (a
//   "plan" call, as Codex's update_plan is), usage_update → the context the session uses.
import { randomUUID } from "node:crypto";
import type { UIMessage, UIMessageChunk } from "ai";
import type { AcpUpdate } from "./acp.ts";
import { meta, obj, stepsOf, type Classify, type ToolMeta } from "./tools.ts";

type Part = UIMessage["parts"][number];
type Emit = (c: UIMessageChunk | Record<string, unknown>) => void;

/** A tool call's name as the harness names it: its _meta's toolName, the name its id starts with, its first title. */
export function toolNameOf(u: AcpUpdate, known?: string): string {
  if (typeof u._meta?.toolName === "string") return u._meta.toolName;
  if (known) return known;
  const prefix = /^([a-z][a-z0-9_]*)__/.exec(String(u.toolCallId ?? ""))?.[1]; // Gemini CLI: "run_shell_command__…"
  if (prefix) return prefix;
  return typeof u.title === "string" && /^[\w-]+$/.test(u.title) ? u.title : String(u.kind ?? "tool");
}

/** A call by what ACP says it is (its kind, its locations, its raw input), for a name the harness's table does not know. */
export const acpTool = (u: { kind?: string; locations?: { path?: string }[]; rawInput?: unknown }): ToolMeta => {
  const o = obj(u.rawInput);
  const files = (u.locations ?? []).map((l) => l.path).filter((p): p is string => typeof p === "string");
  const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  if (Array.isArray(o.todos)) return meta("steps", { steps: { set: stepsOf(o.todos) } });
  switch (u.kind) {
    case "execute": return meta("command", { command: s(o.command) });
    case "read": return meta("read", { files });
    case "edit":
    case "delete":
    case "move": return meta("edit", { files });
    case "search": return meta("search", { query: s(o.pattern) ?? s(o.query) });
    case "fetch": return s(o.url) ? meta("web", { url: s(o.url) }) : meta("webSearch", { query: s(o.query) });
    case "switch_mode": return meta("planMode");
    default: return meta("other");
  }
};

/** The text a tool call's result says: its content's text (a diff: what it changed), else its raw output. */
export function outputOf(u: AcpUpdate): string {
  const parts: string[] = [];
  for (const c of Array.isArray(u.content) ? u.content : []) {
    if (c?.type === "content" && typeof c.content?.text === "string") parts.push(c.content.text);
    else if (c?.type === "diff" && typeof c.path === "string") parts.push(`${c.oldText == null ? "created" : "changed"} ${c.path}`);
  }
  if (parts.length) return parts.join("\n");
  const raw = u.rawOutput;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof raw.output === "string") return raw.output;
  return raw === undefined ? "" : JSON.stringify(raw);
}

const has = (v: unknown) => v && typeof v === "object" && Object.keys(v as object).length > 0;

/**
 * One reply of the agent's (a turn's updates, from its message to its end): the chunks it streams, the parts it
 * leaves, its answer (the text after its last call). `classify`: the harness's table for its tools' names; a name it
 * does not know is read by its ACP kind (acpTool).
 */
export class Reply {
  readonly parts: Part[] = [];
  private open: { kind: "text" | "reasoning"; id: string; message?: string; at: number } | null = null;
  private tools = new Map<string, { name: string; input: unknown; at: number; done: boolean }>();
  private plans = 0;
  answer = "";
  private emit: Emit;
  private classify?: Classify;

  constructor(emit: Emit = () => {}, classify?: Classify) {
    this.emit = emit;
    this.classify = classify;
  }

  private metaOf(name: string, u: AcpUpdate, input: unknown, output?: unknown): ToolMeta {
    const known = this.classify?.(name, input, output);
    return known && known.kind !== "other" ? known : acpTool({ ...u, rawInput: input });
  }

  private close() {
    if (!this.open) return;
    this.emit({ type: this.open.kind === "text" ? "text-end" : "reasoning-end", id: this.open.id });
    this.open = null;
  }

  private write(kind: "text" | "reasoning", text: string, message: string | undefined, at: number) {
    if (!text) return;
    if (!this.open || this.open.kind !== kind || (message && this.open.message && message !== this.open.message)) {
      this.close();
      this.open = { kind, id: randomUUID(), message, at };
      this.emit({ type: kind === "text" ? "text-start" : "reasoning-start", id: this.open.id });
      this.parts.push(kind === "text" ? { type: "text", text: "", state: "done" } : { type: "reasoning", text: "", state: "done" });
      if (kind === "text") this.answer = "";
    }
    this.emit({ type: kind === "text" ? "text-delta" : "reasoning-delta", id: this.open.id, delta: text });
    const last = this.parts[this.parts.length - 1] as { text: string };
    last.text += text;
    if (kind === "text") this.answer += text;
  }

  private part(id: string): any {
    return this.parts.find((p: any) => p.type === "dynamic-tool" && p.toolCallId === id);
  }

  /** One update, at time `at` (ms). Returns the usage it tells, if it is a usage_update. */
  update(u: AcpUpdate, at = Date.now()) {
    const text = typeof u.content?.text === "string" ? u.content.text : "";
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        return this.write("text", text, u.messageId, at);
      case "agent_thought_chunk":
        return this.write("reasoning", text, u.messageId, at);
      case "tool_call":
      case "tool_call_update": {
        const id = String(u.toolCallId ?? "");
        if (!id) return;
        let t = this.tools.get(id);
        if (!t) {
          this.close();
          t = { name: toolNameOf(u), input: has(u.rawInput) ? u.rawInput : {}, at, done: false };
          this.tools.set(id, t);
          const m = this.metaOf(t.name, u, t.input);
          this.emit({ type: "tool-input-start", toolCallId: id, toolName: t.name, dynamic: true, toolMetadata: m });
          this.emit({ type: "tool-input-available", toolCallId: id, toolName: t.name, input: t.input, dynamic: true, toolMetadata: m });
          this.parts.push({ type: "dynamic-tool", toolName: t.name, toolCallId: id, state: "input-available", input: t.input, toolMetadata: m } as Part);
          this.answer = "";
        } else if (has(u.rawInput) && JSON.stringify(u.rawInput) !== JSON.stringify(t.input)) {
          t.input = u.rawInput;
          const m = this.metaOf(t.name, u, t.input);
          this.emit({ type: "tool-input-available", toolCallId: id, toolName: t.name, input: t.input, dynamic: true, toolMetadata: m });
          Object.assign(this.part(id), { input: t.input, toolMetadata: m });
        }
        if ((u.status === "completed" || u.status === "failed") && !t.done) {
          t.done = true;
          const output = outputOf(u);
          const m = this.metaOf(t.name, u, t.input, output);
          if (u.status === "completed") {
            this.emit({ type: "tool-output-available", toolCallId: id, output, dynamic: true, toolMetadata: m });
            Object.assign(this.part(id), { state: "output-available", output, toolMetadata: m });
          } else {
            this.emit({ type: "tool-output-error", toolCallId: id, errorText: output || "failed", dynamic: true });
            Object.assign(this.part(id), { state: "output-error", errorText: output || "failed" });
          }
        }
        return;
      }
      case "plan": {
        // The agent's list of steps: as a call, as the app reads lists of steps.
        this.close();
        const id = `plan-${++this.plans}-${randomUUID().slice(0, 8)}`;
        const input = { entries: u.entries ?? [] };
        const m = meta("steps", { steps: { set: stepsOf(u.entries) } });
        this.emit({ type: "tool-input-start", toolCallId: id, toolName: "plan", dynamic: true, toolMetadata: m });
        this.emit({ type: "tool-input-available", toolCallId: id, toolName: "plan", input, dynamic: true, toolMetadata: m });
        this.emit({ type: "tool-output-available", toolCallId: id, output: "Plan updated", dynamic: true, toolMetadata: m });
        this.parts.push({ type: "dynamic-tool", toolName: "plan", toolCallId: id, state: "output-available", input, output: "Plan updated", toolMetadata: m } as Part);
        return;
      }
    }
  }

  /** The reply ends: what is open closes; a call never finished is left as it was (it shows still waiting). */
  end() {
    this.close();
  }

  /** A call's name as the harness named it when it was announced (a permission request's title may be its command). */
  toolName(id: string): string | undefined {
    return this.tools.get(id)?.name;
  }
}

/** The ACP stop reasons, as a turn's status. */
export const statusOf = (stopReason: unknown) => (stopReason === "cancelled" ? "interrupted" : stopReason === "end_turn" || stopReason === undefined ? "completed" : String(stopReason));
