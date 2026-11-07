---
description: Every hook and component `pagent` exports for pages (what each returns or does), every type, and what `pagent/server` exports for server code.
---

# Reference

- [Hooks and components](#hooks-and-components)
- [Types](#types)
- [pagent/server](#pagentserver)

## Hooks and components

Everything `pagent` exports for pages. All hooks take an optional agent: a handle from `useAgent`, or a name
(`"main"`, `"/path#main"`).

| | Returns / does |
|---|---|
| `useData<T>(file, initial?)` | `[value, set, loaded]` for a data file of this node; `"~/reading/items.json"` = another node's file, live. Write with an updater ([data-actions](data-actions.md#data-files-usedata)); a refused write rejects with `DataConflict` |
| `useAgent(name?)` | an agent handle: `{ node, agent, ask(message) => Promise<reply> }` |
| `useAsk()` | `(message) => Promise<reply>` to the nearest agent up the tree |
| `useAgentStatus(agent?)` | `{ busy, doing, since, activity, questions, queued, session }`, live: `busy` while it works, `doing` = what it is doing as `{ label, tool?, detail? }` (show `label`, a few plain words like "Editing page.tsx", in the app's language; `tool` and `detail` are the call itself), `since` = when its turn started (ms), `activity` = the same as one raw line ("Edit page.tsx"), `questions` = what it is waiting on the user for, `queued` = messages waiting for its turn on the server (`QueuedMessage`: `{ id, user, caller }`, oldest first; the console shows the person's, with × to withdraw one); `session.can` = what its harness can do (a terminal, a timeline …), `session.usage` = its token use (`context` of `window`, totals, `compactions`, rate `limits` when the harness says them); `loaded` once it has been read (before, a guess: idle, nothing of its session) |
| `useAgentEvents(onEvent, agent?)` | every event of the agent, one call each (`run-start`, `activity`, `run-end`, `question` …): for reacting to each tool call, where `useAgentStatus` only has the latest |
| `useAgentChat(agent?)` | the agent's conversation as AI SDK's `useChat` has it, plus `loaded`: `{ messages, sendMessage, status, loaded, earlier, loadEarlier }`, every turn whoever started it, from its latest 80 (`earlier`: how many messages come before them; `loadEarlier()` puts the 80 before in front). For a page that builds its own conversation view, or sends a message as the person's own |
| `useTrajectory(agent?)` | `{ records, loaded, error, record(id) }`: the agent's session as a timeline, live (read again as its turns start, step and end): `TrajectoryRecord`s in time order, `{ id, turnId, kind, start, end?, name?, input?, output?, thinking?, error?, usage?, model?, parent?, … }`. `kind`: `turn` (its message to the end of what it waited for; `usage` summed, `costUSD` when the harness says it, `ttftMs`, `status`), `user` (`from`: the caller, none for a person; `via`: `app`, `terminal` typed in the harness's own terminal, `harness` its own notice), `assistant` (one model request: `output`, `thinking`, `usage` = `{ input, cacheRead, cacheWrite, output }`, `model`), `tool`, `subagent` (its steps have it as `parent`; `background`), `compaction`, `wait` (on the person: `wait` = permission, question or form; `name` the question, `output` the answer). `turnId` is the turn's `ChatTurn.id` / `TurnEvent.messageId`. Times are what the harness recorded (ms); no `end`: still going. Long inputs and outputs are cut (`truncated`): `await record(id)` has one whole. For a page that shows how an agent worked (a timeline, a cost table); a conversation does not need it |
| `useEmit<T>(event)` | `(payload) => void`: the parent gets it as the `on<Event>` prop |
| `useTool(name, fn)` | implements a page tool declared in `export const tools`; `fn(input)` returns the result |
| `useNode()` | `{ path }` of this node |
| `navigate(url)` | go to a page of the app in code, as a link does (after a rename, "New session") |
| `usePathname()`, `useParams()` | the address on screen, as people read it, and the params of the page on screen, live: a layout that stays mounted follows the page under it (its own params are its `params` prop) |
| `useLanguage()`, `setLanguage(tag \| null)` | the language the app is read in (`"zh-CN"`: the reader's choice, else the home page's `metadata.lang`, else the browser's), for the app's own words; the engine's words are in the same one (English when they have none for it). `setLanguage` is the reader's choice (their setting `lang`, for every app of theirs); `null` goes back to `metadata.lang`, else the browser's. `useLanguage({ chosen: true })`: the reader's choice alone (`null`: none) |
| `useTheme()`, `setTheme("light" \| "dark" \| null)` | light or dark, as the app is shown now (the reader's choice, else the system's); `setTheme` is the reader's choice (their setting `theme`), which the shell (rail, top bar), every page and every other app follow (`data-theme` on the document; pages that use the `--pagent-*` variables need nothing); `null` goes back to the system's. `useTheme({ chosen: true })`: the choice alone (`null`: the system's). Read `useTheme()` only for what picks its own colors (a canvas, a chart) |
| `useSettings()`, `setSetting(key, value)` | the person's settings, the same in every pagent app of theirs on the machine, live (a change in any app, any tab, shows here): `{ lang, theme, harness, harnesses }` (`harness`: the id of one of `harnesses` (`[{ id: "claude", title: "Claude Code" }, …]`, the engine's runners), what an agent declared without a `cli` runs; an app that makes sessions preselects it and lists `harnesses` as the choice). `setSetting("harness", "codex")` changes one for every app (`null`: its default); a promise, rejected (and the setting as it was) when the value is none it takes. The person changes them in the shell's Settings; a page rarely needs to. In server code: `settings()` from `"pagent/server"` |
| `<AgentFab />`, `<AgentBar />`, `<AgentConsole inline? empty? cards? chatter? turnFooter? complete? prepare? />`, `<Chat cards? chatter? />` | conversation surfaces ([agents](agents.md#conversation-surfaces)); they render cards in replies. `cards`: `"open"` (default), `"folded"` (a title row until opened: for a page whose panels already show what the cards would), `"compact"` (shorter). `chatter`: turns between agents fold into a line each (default), `"show"` shows them. A page that is a conversation adds to the console: `turnFooter={(turn, turns) => …}` under each turn (`ChatTurn`: `{ id, prompt, messages, running }`, `id` the `messageId` a turn trigger got for that turn; `turns`: all of them, the same array for one render, to match something over the conversation once), `complete={{ "@": (query) => files }}` suggestions in its composer for a word starting with that character (`Completion`: a string, or `{ value, label }`; picking one puts `@value ` in), `prepare={(text) => …}` what goes to the agent for what the person wrote, as they send it (a line before it naming the files they edited since; it is the message, shown as sent) |
| `useComposer(agent?)` | `{ insert(text) }`: text into the console's composer from elsewhere on the page (a file's "Mention" button) |
| `usePlan(agent?)` | the agent's plan as its conversation has it, live: `{ proposal, steps, explanation?, loaded }`. `proposal`: the latest plan it proposed before changing anything, `{ text, state }` (markdown; `"asking"` while it waits for the person's approval, given in the conversation's card, then `"approved"` or `"declined"`; `"proposed"` from a harness that asks nothing); `steps`: its list as it works, `{ text, status: "pending" \| "active" \| "done" }[]`; null when there is none. Whichever harness (Claude Code's plan mode and todos, Codex's plan and update_plan). For a panel beside the conversation: the console already shows both where they happen |
| `<Markdown>{text}</Markdown>`, `<StepList steps />` | markdown as replies show it (a file's preview, a plan; no cards); a list of steps, ticked off |
| `<Terminal agent? />` | the agent's own CLI on its session ([agents](agents.md#the-terminal)) |

## Types

- For the declarations: `Agents` (`AgentSpec`, or `RemoteAgentSpec` for another app's agent), `Tools`, `Triggers`,
  `Config`, `McpServer`; `Params` (a dynamic page's); `TurnEvent` (a turn trigger's action's input).
- For the hooks: `AgentHandle` (an `AgentRef`, `{ node, agent }`, that can `ask`), `AgentStatus` (with `Activity`,
  `Question`, `QueuedMessage`, `Say`, `SessionUsage`, `RateLimit`, `SubagentInfo`), `AgentEvent`, `ChatTurn`, `Completion`, `Theme`,
  `Settings`, `Plan`, `PlanStep`, `Proposal`, `Trajectory`, `TrajectoryRecord`, `TrajectoryKind`, `TrajectoryUsage`.
- `DataConflict`: the error a refused `useData` write rejects with.

Read these and this skill rather than the engine's source.

## pagent/server

What server code (a `"use server"` file, a route, a dynamic page's `agents()`) imports from `"pagent/server"`:

| | Does |
|---|---|
| `data` | the node's data files: `data.read(file, fallback)`, `data.write(file, value)` ([data-actions](data-actions.md#server-codes-own-imports-data-node-settings)) |
| `node` | the node this code runs as: `{ path, params, dir, root }` |
| `settings()` | the person's settings, `{ lang, theme, harness }`, read each call |
| `tell(agent, text, opts?)` | a message to an agent of this app or another app's message route ([routes](routes.md#tell-from-server-code)) |
| `inbox` | the default message route: `export { inbox as POST } from "pagent/server"` ([routes](routes.md#an-agents-message-route)) |
| `keys` | `keys.create({ scope, ttl?, name? })`, `keys.revoke(name)` ([routes](routes.md#keys-who-a-caller-is)) |
| `nodes` | a dynamic page's instances: `instances`, `make`, `move`, `remove` ([instances](instances.md#listing-renaming-removing)); `Instance` is one |
| `agentStatus(address?)` | what an agent is doing now (`AgentNow`: `{ address, busy, activity, since, quietSince, stuck, queued, offline? }`, as `useAgentStatus` in short); without an address, every agent of the app |
| `ax` | the apps on this Mac, through the accessibility API ([bridges](bridges.md#reading-and-acting-ax)) |
| `RouteContext` | the type of a route handler's second parameter, `{ caller, params, url }` |
