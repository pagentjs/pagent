// Codex's tools, as what they do (tools.ts): the names its items get as calls (codex-items.ts toolOf, codex.ts):
// shell (commandExecution), apply_patch (fileChange, its changes' paths), web_search, view_image, mcp__<server>__<tool>
// (mcpToolCall), spawn_agent and the sub-agent calls (wait, send_input, resume_agent, close_agent), update_plan (the
// turn's plan, turn/plan/updated) and plan (a plan proposed in plan mode, which asks nothing: the person answers in
// the conversation).
import { commonOf, mcpServer, meta, obj, stepsOf, type Classify, type ToolMeta } from "./tools.ts";

export const codexTool: Classify = (name, input): ToolMeta => {
  const { o, files, command, query } = commonOf(input);
  switch (name) {
    case "shell":
    case "exec_command":
    case "local_shell":
      return meta("command", { command: command ?? (Array.isArray(o.command) ? o.command.join(" ") : undefined) });
    case "apply_patch": {
      const changed = (Array.isArray(o.changes) ? o.changes : []).map((c) => obj(c).path).filter((p): p is string => typeof p === "string");
      return meta("edit", { files: changed.length ? changed : files });
    }
    case "web_search":
      return meta("webSearch", { query });
    case "view_image":
      return meta("read", { files });
    case "spawn_agent":
      return meta("subagent");
    case "wait":
    case "send_input":
    case "resume_agent":
    case "close_agent":
      return meta("subagents");
    case "update_plan":
      if (!Array.isArray(o.plan)) return meta("steps");
      return meta("steps", { steps: { set: stepsOf(o.plan), ...(typeof o.explanation === "string" && o.explanation.trim() ? { explanation: o.explanation } : {}) } });
    case "plan":
      return meta("proposal", { plan: typeof o.plan === "string" ? o.plan : "", asks: false });
  }
  if (name.startsWith("mcp__")) return meta("mcp", { server: mcpServer(name) });
  return meta("other");
};
