---
description: Declaring agents (cli, runner, instructions, allow, cwd, sessionId, model, effort, resident, shell), what each harness can do, skills and MCP servers, the root's .claude/settings.json, sessions, picking an agent, agents telling each other, sub-agents, conversation surfaces, the terminal.
---

# Agents

- [Agent options](#agent-options)
- [Skills and MCP servers](#skills-and-mcp-servers)
- [What no agent of the app may do](#what-no-agent-of-the-app-may-do)
- [A folder is a session](#a-folder-is-a-session)
- [A Grok Bot agent](#a-grok-bot-agent)
- [Which agent: useAgent, useAsk](#which-agent-useagent-useask)
- [Agents talk to each other](#agents-talk-to-each-other)
- [Conversation surfaces](#conversation-surfaces)
- [The terminal](#the-terminal)

## Agent options

`export const agents = { <name>: { … } } satisfies Agents`, one entry per agent, the key its name. Each field is
optional:

- **`cli`**: the harness: `"claude"` (Claude Code), `"codex"`, `"opencode"`, `"gemini"` (Gemini CLI), `"qwen"` (Qwen
  Code), `"grokbot"` ([a Grok Bot bot](#a-grok-bot-agent)), each one of the engine's runners. Left out: the person's default harness, in their Settings. The agent keeps
  the one it first ran with, as a conversation cannot move to another harness. Not every harness can do everything:
  opencode's terminal attaches to the agent's session, Gemini CLI and Qwen Code have none in the app, Codex and the ACP
  ones answer no strangers ([routes](routes.md)). A page shows only what the agent's can, from
  `useAgentStatus().session.can`.
- **`instructions`**: a file in the node's folder, e.g. `_agent.md`, with what this agent is for and how it works:
  added to its system prompt. The leading underscore keeps it code, not data.
- **`allow`**: what its harness lets it do without asking: Claude Code's own permission rules, `["WebFetch",
  "Bash(curl:*)"]`; Codex has no such rules, its sandbox decides. `pagent` needs none, it is pre-approved. Declare what
  its job needs, above all when it runs from triggers, where nobody can approve anything.
- **`cwd`**: the folder its harness works in: its node's by default; a project folder elsewhere, which several agents
  may share. Absolute, or relative: `"~/…"` from the app's root (`"~/../agents/ops"`, a folder beside the app, keeps
  working when the app and its folders move together), anything else from the node's folder. An agent working outside the app is told that folder is its work, and the app's code is not, so its
  instructions need not say so.
- **`sessionId`**: adopt an existing CLI session.
- **`model`**, **`effort`**: the harness's model and reasoning effort.
- **`resident`** (default true): once the agent's terminal is open it stays open; `false` or a number of minutes: it
  closes when nobody watches and the agent was quiet that long, and the next message resumes the session.
- **`shell`**: every harness already starts with the user's login-shell environment, so keys and PATH from their
  `~/.zshrc` are there; `shell: true` also starts its terminal through that shell, so the user's own function or alias
  wrapping `claude` / `codex` runs (headless turns get the environment only).
- Or **`runner`** instead of `cli`: a runner script of the app's own, `"~/_runners/cli.ts"` from the app's root or
  `"./x.ts"` beside the code, so the app still works when moved.
- Or **`remote`** alone: another app's agent, declared as one of this app's ([routes](routes.md#remote-agents)).

## Skills and MCP servers

**The harness's own, unless declared.** By default an agent has what its harness has for the user (their `~/.claude`
/ `~/.codex`: skills, plugins, MCP servers). Declare `skills` and/or `mcps` on the agent, or in a node's `export const
config` (for its agents and the ones below; the nearest declaration wins, per category), and that agent gets only those
for that category, none of the user's (plus pagent's own skill):

- `skills: ["~/skills/design"]`: folders with a SKILL.md, or a folder of them; `~/` is the app, `./` this node's
  folder.
- `mcps: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } }`: the harness's own
  JSON, by name, `{ type: "http", url }` too; secrets stay out of code, in the environment; `{}` is none.

Declare them when an agent should not depend on how this machine's user set up their CLI (an app others will run, an
agent that must not see the user's other tools); otherwise leave them out.

## What no agent of the app may do

The root's `.claude/settings.json`. Claude Code reads a project's settings only in the folder it starts in, and each
agent starts in its node's folder; so every Claude Code agent of the app also gets the `permissions.deny` and
`permissions.ask` rules of the app root's `.claude/settings.json` (and `settings.local.json`). `{ "permissions": {
"deny": ["Read(//**/.env)"] } }` there keeps all of them out of the `.env` files. A path in such a rule is the root's
for every agent (`Read(/secrets/**)` and `Read(secrets/**)` are the root's `secrets`, `Read(.env)` any `.env` in the
app). Its `allow` holds only for the root's agent (declare what another agent needs with its `allow`), and so does
everything else in it; a node folder's own `.claude/settings.json` holds for the agent of that folder.

## A folder is a session

Without `sessionId`, an agent working in its node's folder continues the latest session there (like `claude
--continue`), so the same conversation is reachable from the CLI. So one such agent per folder and harness: a Claude
Code agent and a Codex one may share a node, a second Claude Code one goes in a child folder. A runner of the app's own
that keeps a session per agent says `sessions: "agent"` in its describe, and any number of its agents may share one.
An agent with a `cwd` elsewhere (a project folder other agents may work in too) has a session of its own:
a fresh one the first time, remembered and resumed after that, never that folder's latest.

## A Grok Bot agent

`{ cli: "grokbot", bot: "Researcher" }` is a bot of Grok Bot (xAI's always-on agent on its own cloud computer, with a
very good X search): other agents `tell` it things, it works in the cloud, and its replies and approval cards come back
here. `bot` is the bot's name or id (`gbot bots list`); `createBot: true` makes it when there is none. The
machine needs `gbot` (npm `grok-bot-cli`) and the Grok Bot desktop app, signed in.

- Its replies arrive a message at a time, not streamed, and its steps (an X search, a command) do not show; a schedule
  it makes does. Its thread never says it is done: a turn ends once the bot has said something and then nothing for
  `quietSeconds` (20), and waits `waitMinutes` (30) at most.
- Its approval cards are permission cards in the app: Allow accepts once, Deny declines (never a lasting permission).
- Stop ends the wait, not the bot's work. What it says outside a turn (a reply after its turn ended, a scheduled
  task's report, its answer to someone who wrote to it in Grok Bot's own app or with `gbot`) is no turn: it shows in
  its conversation once its thread is read, and its [turn triggers](triggers.md#turn-triggers) get it once, as
  `phase: "message"` (route it from there: tell someone, write data). Its thread is read during a turn and for 10
  minutes after anything happened, when its console opens, and every `follow` when declared (`follow: "30m"`, at least
  a minute; its session then runs as long as the app). Each read may wake its cloud computer, so nothing reads it
  otherwise: without `follow`, a report that comes hours later waits for the next turn or a look at the agent.
- It cannot run `pagent` and gets no system prompt or skills from the app. Give it a **workspace**
  (`workspace: "~/team/media/scout"`): a bot pagent makes is first told to read its README.md and keep its notes
  there. Keep its schedules in the app's [triggers](triggers.md): then the bot is only a name. No terminal, no token
  use, no strangers.
- **Accounts.** Usage is weekly per Grok Bot account. With several given to pagent (`pagent grokbot login <name>`,
  in the person's terminal), each turn goes to the first with usage left, the bot made there by name (declare `bot`
  by name). Without them, it is the Grok Bot app's account.
- A turn that cannot reach it says what to do (sign in to Cursor, relaunch the Grok Bot app, update gbot; no
  usage left: when it comes back).

## Which agent: useAgent, useAsk

- **`useAgent()`** is this node's agent when it declares exactly one, else the nearest one above. `useAgent("name")`
  picks one of this node's agents; `useAgent("/path#name")` any node's. Surfaces and hooks take `agent="name"` the
  same way.
- **Not every node needs an agent.** `useAsk()` reaches the nearest agent up the tree (which may hand it further up
  with `pagent tell ..`).

## Agents talk to each other

- `pagent agents` lists every agent in the app; it says how long a busy one has been quiet, and `stuck` when it is 15
  minutes or more.
- `pagent tell /ops#ops "…"` delegates: its result comes back to you later as a message, "Result of your delegation to
  /ops#ops (message <id>)", the id `tell` gave you. `--wait` waits for a quick reply; `--interject` puts it into the
  turn the other agent is in (it reads it between two steps) instead of after it; `--new` makes a new instance of a
  dynamic page and tells its agent ([instances](instances.md)); `--no-reply` is for a notice or a receipt: what it
  says back goes to no one, so it does not wake you to read "done" (the other agent sees "(from …, no reply)").
- `pagent tell .. "…"` is the nearest agent above your node (as `cd ..`): hand it something that belongs to its part of
  the app.
- `pagent stop /ops#ops` stops its turn in progress (as Esc in its terminal); its waiting messages still go to it
  after.
- **Short tasks: your harness's own sub-agents** (Claude Code's Agent tool, Codex's spawn_agent), not new agents or
  pages; the app shows them in your conversation as they work.

## Conversation surfaces

Only where a page really is a conversation (most pages need none):

- `<AgentFab />`: a corner status button that opens a bar or a full-screen console.
- `<AgentBar />`: an input at the bottom of the page; the reply shows as one bubble above it.
- `<AgentConsole />`: full screen, every turn with its tool calls (`inline`: in the page's flow instead).
- `<Chat />`: an inline chat.

Each defaults to this node's agent (`agent="name"` for another) and renders cards in replies ([cards](cards.md)).
Their props (which turns fold, a footer under each turn, completions in the composer, what goes to the agent for what
the person wrote) are in [reference](reference.md). Show an agent's progress elsewhere on the page with
`useAgentStatus`; its plan with `usePlan`; its session as a timeline with `useTrajectory`.

## The terminal

**`<Terminal agent="…" />`** shows the agent's own CLI (Claude Code / Codex) on the same session, for pages that adopt
a local session or want the real CLI. It keeps running when the page closes. While it is open, messages to a Claude
Code agent are typed into it; a Codex TUI shares its thread with the app, so messages from either side show up in both.

A Claude Code agent's terminal runs even when nobody watches it. A dialog it puts up there (a question, one of Claude
Code's own prompts) becomes a card on any page. A changed declaration (a `model`) reaches it once it restarts, before
the agent's next message unless someone is in it; so does an update of its CLI, and a terminal nobody is in restarts on
the new version by itself once it has been quiet a minute (on the same session). If it cannot come up, turns run without it, and the console says why
(`useAgentStatus().headless`). A message it starts no turn for within a minute gets Enter again; still nothing a
minute later, that message fails (the error says so) and the next one goes.
