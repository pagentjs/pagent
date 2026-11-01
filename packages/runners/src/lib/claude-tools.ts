// Claude Code's tools, as what they do (tools.ts). Its own names (2.1.302): Bash, Read, Write, Edit, MultiEdit,
// NotebookEdit, Grep, Glob, LS, WebFetch, WebSearch, Agent (Task before it), Skill, ToolSearch, TodoWrite and the newer
// TaskCreate / TaskUpdate, ExitPlanMode / EnterPlanMode, AskUserQuestion; an MCP server's as mcp__<server>__<tool>.
import { readFileSync } from "node:fs";
import { commonOf, mcpServer, meta, obj, stepsOf, stepStatus, type Classify, type ToolMeta } from "./tools.ts";

/**
 * The plan an ExitPlanMode proposes: its input's `plan`; else, live (the permission hook, the turn as it happens), the
 * plan file it names (Claude Code keeps the plan in a markdown file, rewritten as it plans), which is that plan now;
 * else, from a transcript, what its result carries ("## Approved Plan:" when it was approved). Never the file for a
 * transcript: that is today's plan, not the one this call proposed (and a sync read per proposal per history read).
 * "" when there is none.
 */
export function planOf(input: unknown, output?: unknown, live = false): string {
  const o = obj(input);
  if (typeof o.plan === "string") return o.plan;
  const file = o.planFilePath ?? o.filePath;
  if (live && typeof file === "string" && file.endsWith(".md")) {
    try {
      return readFileSync(file, "utf8").slice(0, 100_000);
    } catch {}
  }
  const said = typeof output === "string" ? /## Approved Plan:?[ \t]*\n([\s\S]*)$/.exec(output)?.[1] : undefined;
  return said?.trim() ?? "";
}

/** Claude Code's table for what happens now (a permission request, a live turn): a proposal's plan from its file. */
export const claudeToolLive: Classify = (name, input, output): ToolMeta => (name === "ExitPlanMode" ? meta("proposal", { plan: planOf(input, output, true), asks: true }) : claudeTool(name, input, output));

/** Claude Code's table: what each of its calls is (as a transcript has it). */
export const claudeTool: Classify = (name, input, output): ToolMeta => {
  const { o, files, command, query, url } = commonOf(input);
  switch (name) {
    case "Bash":
      return meta("command", { command });
    case "Read":
      return meta("read", { files });
    case "Write":
      return meta("write", { files });
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return meta("edit", { files });
    case "Grep":
    case "Glob":
    case "LS":
      return meta("search", { query: query ?? (typeof o.path === "string" ? o.path : undefined) });
    case "WebFetch":
      return meta("web", { url });
    case "WebSearch":
      return meta("webSearch", { query });
    case "Agent":
    case "Task":
      return meta("subagent");
    case "Skill":
      return meta("skill");
    case "ToolSearch":
      return meta("toolSearch", { query });
    case "TodoWrite":
      return meta("steps", Array.isArray(o.todos) ? { steps: { set: stepsOf(o.todos) } } : {});
    case "TaskCreate": {
      if (typeof o.subject !== "string") return meta("steps");
      // Its number is in its result ("Task #3 created"); before that, the next in order.
      const id = /#(\d+)/.exec(typeof output === "string" ? output : "")?.[1];
      return meta("steps", { steps: { add: { text: String(o.subject ?? ""), status: "pending", ...(id ? { id } : {}) } } });
    }
    case "TaskUpdate":
      if (o.taskId === undefined) return meta("steps");
      return meta("steps", {
        steps: {
          update: {
            id: String(o.taskId ?? ""),
            ...(o.status === "deleted" ? { deleted: true as const } : o.status ? { status: stepStatus(o.status) } : {}),
            ...(typeof o.subject === "string" ? { text: o.subject } : {}),
          },
        },
      });
    case "ExitPlanMode":
      return meta("proposal", { plan: planOf(input, output), asks: true });
    case "EnterPlanMode":
      return meta("planMode");
    case "AskUserQuestion":
      return meta("ask");
  }
  if (name.startsWith("mcp__")) return meta("mcp", { server: mcpServer(name) });
  return meta("other");
};
