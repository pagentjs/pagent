// Gemini CLI's tools, as what they do (tools.ts), and Qwen Code's, which keeps Gemini CLI's names (it began as a fork
// of it): run_shell_command, read_file, read_many_files, write_file, replace (edit), glob, search_file_content,
// list_directory, web_fetch, google_web_search, write_todos (Gemini) / todo_write (Qwen), task, skill, exit_plan_mode.
// Gemini CLI 0.60.0, Qwen Code 0.19.11. Over ACP a call's name is in its id (Gemini: "run_shell_command__…") or its
// _meta (Qwen: toolName), acp-turns.ts.
import { commonOf, mcpServer, meta, obj, stepsOf, type Classify, type ToolMeta } from "./tools.ts";

export const geminiTool: Classify = (name, input): ToolMeta => {
  const { o, files, command, query, url } = commonOf(input);
  switch (name) {
    case "run_shell_command":
      return meta("command", { command });
    case "read_file":
    case "read_many_files":
      return meta("read", { files: files ?? (Array.isArray(o.paths) ? o.paths.filter((p): p is string => typeof p === "string") : undefined) });
    case "write_file":
      return meta("write", { files });
    case "replace":
    case "edit":
      return meta("edit", { files });
    case "glob":
    case "search_file_content":
    case "grep_search":
    case "list_directory":
    case "ls":
      return meta("search", { query: query ?? (typeof o.dir_path === "string" ? o.dir_path : undefined) });
    case "web_fetch":
      return meta("web", { url: url ?? (typeof o.prompt === "string" ? /https?:\/\/\S+/.exec(o.prompt)?.[0] : undefined) });
    case "google_web_search":
    case "web_search":
      return meta("webSearch", { query });
    case "write_todos":
    case "todo_write":
      return meta("steps", Array.isArray(obj(input).todos) ? { steps: { set: stepsOf(obj(input).todos) } } : {});
    case "task":
    case "agent":
      return meta("subagent");
    case "skill":
    case "activate_skill":
      return meta("skill");
    case "exit_plan_mode":
      return meta("proposal", { plan: typeof o.plan === "string" ? o.plan : "", asks: true });
    case "ask_user":
    case "ask_user_question":
      return meta("ask");
  }
  const server = mcpServer(name);
  return server ? meta("mcp", { server }) : meta("other");
};
