// What a tool call does, whatever its harness calls it (SPEC 13.18). Each harness names its tools its own way (Claude
// Code's Bash and TodoWrite, Codex's shell and update_plan, opencode's bash and todowrite, Gemini CLI's
// run_shell_command and write_todos …); the runner that knows the harness says what each call is, in one shape, as the
// call's `toolMetadata` (a field AI SDK keeps on a dynamic-tool part and on its chunks). So the app reads what an agent
// does, its plan and its steps, without knowing any harness: the bridge's chips, plan and step list, the core's status
// lines and permission cards all go by this (bridge/src/contract.ts has the same type, ToolMeta).
//
// A runner says it on every tool call it gives, live (tool-input-start, tool-input-available, and again on
// tool-output-available when the output tells more, e.g. the number a new task got) and in its history (each
// dynamic-tool part, a sub-agent's steps too). annotate() does that for a runner, given the harness's own table.
import type { UIMessage } from "ai";

/** What a call does. Anything a harness has that is none of these is "other" (its name is still shown). */
export type ToolKind =
  | "command" // runs a shell command (meta.command)
  | "read" // reads files (meta.files)
  | "write" // writes a file whole (meta.files)
  | "edit" // changes files (meta.files)
  | "search" // looks through files (meta.query)
  | "web" // reads a web page (meta.url)
  | "webSearch" // searches the web (meta.query)
  | "subagent" // starts a sub-agent (its data-subagent part follows)
  | "subagents" // waits for, messages or closes its sub-agents
  | "skill" // loads a skill
  | "toolSearch" // looks for a tool it does not have loaded
  | "steps" // its list of steps changes (meta.steps)
  | "proposal" // proposes a plan before it changes anything (meta.plan)
  | "planMode" // asks to plan first
  | "ask" // asks the person a question in the harness's own way
  | "mcp" // a tool of an MCP server (meta.server)
  | "other";

export const TOOL_KINDS: readonly ToolKind[] = ["command", "read", "write", "edit", "search", "web", "webSearch", "subagent", "subagents", "skill", "toolSearch", "steps", "proposal", "planMode", "ask", "mcp", "other"];

/** A step of the agent's list: what it is, and whether it is to do, under way or done. */
export type PlanStep = { text: string; status: "pending" | "active" | "done" };

/**
 * How a call changes the list of steps: the whole list (`set`, with what the agent says of it), one more (`add`, its id
 * when the harness numbers them), or one of them (`update` by id: its status, its text, or `deleted`).
 */
export type StepsChange =
  | { set: PlanStep[]; explanation?: string }
  | { add: PlanStep & { id?: string } }
  | { update: { id: string; status?: PlanStep["status"]; text?: string; deleted?: true } };

export type ToolMeta = {
  kind: ToolKind;
  /** command: the command line. */
  command?: string;
  /** read, write, edit: the files, as the call names them. */
  files?: string[];
  /** web: the page. */
  url?: string;
  /** search, webSearch: what it looks for. */
  query?: string;
  /** mcp: the server whose tool it is. */
  server?: string;
  /** steps: how the list changes. */
  steps?: StepsChange;
  /** proposal: the plan (markdown); asks: the harness waits for the person's approval (a permission request). */
  plan?: string;
  asks?: boolean;
};

/** A harness's table: what one of its calls is, from its name and input (and its output, once there is one). */
export type Classify = (name: string, input: unknown, output?: unknown) => ToolMeta;

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** A meta with only what is there (no undefined fields: it goes through JSON). */
export function meta(kind: ToolKind, more: Omit<Partial<ToolMeta>, "kind"> = {}): ToolMeta {
  const m: ToolMeta = { kind };
  for (const [k, v] of Object.entries(more)) if (v !== undefined && !(Array.isArray(v) && !v.length)) (m as any)[k] = v;
  return m;
}

/** The fields most harnesses use for what a call is about: a path, a command, a query, a url. */
export function commonOf(input: unknown) {
  const o = obj(input);
  const file = str(o.file_path) ?? str(o.filePath) ?? str(o.absolute_path) ?? str(o.path) ?? str(o.notebook_path);
  return { o, file, files: file ? [file] : undefined, command: str(o.command) ?? str(o.cmd), query: str(o.query) ?? str(o.pattern) ?? str(o.q), url: str(o.url) };
}

/** A status word as harnesses write it, as a step's status. */
export const stepStatus = (s: unknown): PlanStep["status"] =>
  s === "completed" || s === "done" || s === "complete" ? "done" : s === "in_progress" || s === "inProgress" || s === "active" || s === "in-progress" ? "active" : "pending";

/**
 * A whole list of steps from the shape most harnesses write one in: items with content / description / step / text
 * and a status (`activeForm`: what Claude Code says while one is under way).
 */
export function stepsOf(items: unknown): PlanStep[] {
  return (Array.isArray(items) ? items : []).map((x) => {
    const o = obj(x);
    const status = stepStatus(o.status);
    return { text: String((status === "active" && o.activeForm) || o.content || o.description || o.step || o.text || o.title || ""), status };
  });
}

/** An MCP tool's server, from the names harnesses give them ("mcp__github__create_issue", "github__create_issue"). */
export function mcpServer(name: string): string | undefined {
  const m = /^(?:mcp__)?(.+?)__.+$/.exec(name);
  return m?.[1]?.replace(/^plugin_[^_]+_/, "");
}

type Part = UIMessage["parts"][number];
type Out = Record<string, any>;

/**
 * Says what every tool call is, on whatever a runner writes (a chunk, a history, a sub-agent's step): returns the
 * thing with `toolMetadata` on each call, from the harness's table. It remembers each call's name and input (by id),
 * so a tool-output-available can say it again with what the output adds. One per runner process.
 */
export function annotate(classify: Classify) {
  const calls = new Map<string, { name: string; input: unknown }>();
  const safe = (name: string, input: unknown, output?: unknown): ToolMeta => {
    try {
      return classify(name, input, output);
    } catch {
      return { kind: "other" };
    }
  };
  const part = (p: any): Part => {
    if (p?.type === "dynamic-tool" && typeof p.toolName === "string") return { ...p, toolMetadata: safe(p.toolName, p.input, p.state === "output-available" ? p.output : undefined) };
    if (p?.type === "data-subagent-step" && p.data?.part) return { ...p, data: { ...p.data, part: part(p.data.part) } };
    return p;
  };
  return (o: Out): Out => {
    switch (o?.type) {
      case "tool-input-start":
      case "tool-input-available":
        calls.set(o.toolCallId, { name: o.toolName, input: o.input ?? calls.get(o.toolCallId)?.input });
        return { ...o, toolMetadata: safe(o.toolName, o.input) };
      case "tool-output-available": {
        const c = calls.get(o.toolCallId);
        return c ? { ...o, toolMetadata: safe(c.name, c.input, o.output) } : o;
      }
      case "data-subagent-step":
        return part(o);
      case "history":
        return { ...o, messages: (o.messages ?? []).map((m: UIMessage) => ({ ...m, parts: m.parts.map(part) })) };
      default:
        return o;
    }
  };
}
