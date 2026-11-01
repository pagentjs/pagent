---
name: pagent
description: How to create or change a pagent app's nodes - a folder's page.tsx and layout.tsx, its agents, its actions ("use server" files), triggers, data files, child pages and the app's routes - and how to commit and check those changes. Load this before editing any node's code or creating a page or component folder; its chapters (references/, or `pagent docs <topic>`) cover each part in depth.
---

# Writing pagent nodes

**Agents work behind the pages.** Agents in pagent are parts of the app itself. People use pages; the pages pass their
actions to the agents, which answer by changing data and pages. Design pages accordingly:

- Put the agent behind the UI. A "Summarize" button calls `ask("summarize the mails into summary.json")`, and the page
  shows `summary.json`. Do not route the user through a chat to get something done.
- Show progress where the work lands (a spinner on the card being updated, via `useAgentStatus`), not in a transcript.
- Agents render nothing by default. Add a conversation surface (`<AgentFab />`, `<AgentBar />`, `<AgentConsole />`,
  `<Chat />`) only where a page really is a conversation (a console over a local coding session, the place the user
  shapes the app with its builder). Many apps need none.
- Answering the app: what arrives prefixed `(from …)` (a button's `ask`, a trigger, another agent) is answered by
  changing the app (that change is the reply), then saying only what the sender needs: for a page, at most one short
  sentence; for an agent, the answer it asked for. No greetings, recaps or offers, and no questions in prose: when truly
  blocked on a decision, `pagent ask-user` with a few options. A person writing in a conversation gets a natural reply
  in their language; what agents write into pages and data is in the user's language too (the one they write in,
  else the pages'). An app's own instructions
  for its agents (their `_agent.md`) win over these defaults.
- Shaping the app with its user (what pages it should have): the pagent-builder skill, when an agent's instructions
  call for it or the user asks for help deciding what to build.

A **node is a folder** laid out like a Next.js App Router segment. Its code (page.tsx, layout.tsx, other code files,
`_private` folders) is its definition; every other file in it is data. Child folders with a page.tsx are child routes.

```
my-node/
  page.tsx            the page / component (default export)
  layout.tsx          optional: wraps every child route ({children})
  actions.ts          "use server": its actions
  Card.tsx            helper components, imported relatively ("./Card")
  _components/…       private folder: more code, never a route
  data.json           data files, read with useData
  child/page.tsx      a child route: /my-node/child
```

Everything is plain React. Imports are `react`, `pagent`, relative files, other nodes of this app (`~/path`), and npm
packages installed at the app root (`pagent package add`). Never install React or `pagent`: the host provides them.

## Exports declare, hooks use

What a node *is* (its agents, page tools, triggers, title) is declared as module exports. Hooks and components only
*use* them. What it can do without an LLM, its actions, are the functions of its `"use server"` file.

```tsx
// inbox/page.tsx
import { AgentFab, useAgent, useAgentStatus, useAsk, useData, useEmit, useTool, type Agents, type Tools } from "pagent";
import { useState } from "react";
import Mailbox from "~/mailbox";                             // another node of this app, by its path
import { archive } from "./actions";                         // a "use server" file: archive() runs on the server

export const metadata = { title: "Inbox" };                  // what the navigation calls the page

export const agents = {
  helper: { cli: "claude", instructions: "_agent.md" },      // key = agent name; no cli: the person's default harness
} satisfies Agents;

export const tools = {
  show: { description: "Filter the list", input: { status: "all|open|done?" } },   // ? = optional
} satisfies Tools;

type Mail = { id: string; subject: string; done?: boolean };

export default function Page() {
  const [mails = [], setMails] = useData<Mail[]>("mails.json", []);   // a data file of this node, live
  const emit = useEmit<{ id: string }>("mail.archived");     // the parent gets it as onMailArchived
  const helper = useAgent();                                 // this node's agent
  const ask = useAsk();                                      // the nearest agent up the tree
  const { busy } = useAgentStatus();
  const [status, setStatus] = useState("all");
  useTool("show", ({ status }) => (setStatus(status ?? "all"), `Showing ${status ?? "all"}`));
  const shown = mails.filter((m) => status === "all" || (status === "done") === !!m.done);

  return (
    <>
      <button disabled={busy} onClick={() => ask("summarize the open mails into summary.json")}>Summarize</button>
      {shown.map((m) => (
        <div key={m.id}>
          {m.subject}
          <button onClick={() => setMails((prev) => prev.map((x) => (x.id === m.id ? { ...x, done: true } : x)))}>Done</button>
          <button onClick={async () => (await archive({ id: m.id }), emit({ id: m.id }))}>Archive</button>
        </div>
      ))}
      <Mailbox key="work" onMailReceived={helper} />        {/* a child's event goes to an agent */}
      <AgentFab />
    </>
  );
}
```

```ts
// inbox/actions.ts
"use server";
import { data } from "pagent/server";

/** Archive a mail. Agents run it too: pagent run /inbox archive '{"id": "…"}' */
export async function archive({ id }: { id: string }) {
  const mails = data.read<{ id: string }[]>("mails.json", []) ?? [];
  data.write("mails.json", mails.filter((m) => m.id !== id));
}
```

- **`export const agents` / `tools` / `triggers` / `config` / `metadata` must be literals**: the server reads them
  without running your code. The one exception: a dynamic page's `agents` may be a function of its params.
- **A page names itself** with `metadata = { title: "Inbox" }`: navigation shows titles, not paths. Give every page a
  short, plain title (the home page's is the app's name). [pages](references/pages.md).
- **Data**: `useData(file, initial)` is `[value, set, loaded]` for a data file in the node's folder, updated live when
  anyone changes it. **Write with an updater**, `set(prev => …)`: a plain `set(value)` is refused when the file changed
  meanwhile. [data-actions](references/data-actions.md).
- **Actions** are the exported async functions of a `"use server"` file directly in the node's folder: the page awaits
  them, agents `pagent run` them, triggers run them. Secrets (`process.env`), `node:` modules and files belong there
  only. Another node's are imported by its address (`~/mail/actions`). [data-actions](references/data-actions.md).
- **Page tools** (`tools` + `useTool`) are for view state only (a filter, a selection): they run in the user's open
  page. Data goes in files, commands in actions.
- **Agents**: options (`cli`, `instructions`, `allow`, `cwd`, `model` …), sessions, `pagent tell`, conversation
  surfaces: [agents](references/agents.md). **Triggers** make a node act on its own: [triggers](references/triggers.md).
- **Imported nodes are components**: each render is a fork with its own data (distinct `key`s); events go up as
  `on<Event>` props. [pages](references/pages.md).
- Dynamic pages, Mac app bridges, routes, cards, and every hook and type: the chapters at the end. Read them rather
  than the engine's source.

## The `pagent` command

You reach the app with `pagent` in your shell; it knows which agent you are and is pre-approved. `pagent --help`
lists the commands, every command takes `--help`, and `pagent run <node> --help` lists what a node can do. It always
shows the app as it is now. `pagent docs <topic>` prints a chapter of this skill.

- A command that waits for a person (`pagent ask-user`) or another agent (`pagent tell`) returns at once; the outcome
  comes to you later as a message. Carry on or end your turn; do not run it again.
- **A secret (a password, API key, token) only through a Secure Form**, `pagent ask-user "Weather API key" --secret
  --into env:WEATHER_KEY`: it goes straight to the app's `.env` and never to you. Never ask for one in the
  conversation, and never read it back. `pagent ask-user --help` has the rest (choices, small forms, targets).

## Changing the UI

A node's code is **live**: viewers see what is on disk as soon as you save. There is no publish step, so versions are
git commits, and you make them. This is authorized in advance: commit node code yourself, without asking first.

1. **Before** you change a page, commit the node's code as it is if it has uncommitted changes (`git add <the code
   files> && git commit -m "…"`), so the current UI can be restored.
2. Make the change. Run `pagent status` (or `pagent status <node>` for any node of the app) to see compile and
   extraction errors, and fix them: a page that does not compile shows its error to the user.
3. **After**, commit the code you changed with a message that says what changed.

To undo a change, revert its commit (`git revert`) or restore the files from the commit before it. Commit code, not
data files: data is state and must not roll back with the page.

**To move or rename a node, `pagent mv /notes /archive/notes`**, never `mv` or `git mv`: it takes everything with it
(code, data, its agents' state and sessions, the app's imports and addresses that name it, its message route, its
keys) and closes its agents' terminals (they open again at the new place). It is refused while an agent there is in a
turn, so you cannot move your own node: ask the user to run it (`pagent mv … --root <app>`). Data files are not
rewritten. Commit the move afterwards (it lists the files it changed).

To change another node, prefer asking it (its own agent, `pagent tell`) if it has one; you may edit it directly when
you created it or when nobody else owns it. This is a convention, not a limit: your commands reach every node of the
app (the home page may be a dashboard with no agent, and someone still looks after the app), so keep to your own part
unless the work is yours.

## Style

The shell is a neutral frame, and every color, radius and font of it is a CSS variable. Use the same ones, so pages
match it, follow dark mode (the system's, or the reader's `setTheme`), and take on whatever look the app is given
later (a look is new values for these variables, nothing else). Never write a color by hand. Inline styles are fine.

| Variable | For |
|---|---|
| `--pagent-bg` | the page itself |
| `--pagent-surface` | something on the page: a card, a panel, an input |
| `--pagent-surface-2` | a quiet fill: hover, selected, a code or detail block |
| `--pagent-border` | hairlines between things (table rows, a card's edge) |
| `--pagent-border-strong` | the edge of a control |
| `--pagent-text`, `--pagent-muted`, `--pagent-faint` | text; secondary text; meta (times, counts, placeholders: never what must be read) |
| `--pagent-accent`, `--pagent-on-accent` | links, the one main action, "new"; text on an accent fill (not `white`) |
| `--pagent-accent-soft` | a light accent tint (sparingly: a selected day, a tag) |
| `--pagent-danger` | errors, destructive actions |
| `--pagent-working`, `--pagent-waiting` | an agent working (amber), waiting for the user (red): dots, not text |
| `--pagent-radius`, `--pagent-radius-sm` | 10px for cards and panels, 6px for controls |
| `--pagent-shadow` | only what floats (a popover, a menu); things on the page have a border, not a shadow |
| `--pagent-font`, `--pagent-mono` | the text and code faces (with CJK fallbacks) |

- **Buttons and inputs are styled already.** A plain `<button>` is the secondary one; add `className="pagent-primary"`
  for the main action (at most one in a group) and `"pagent-ghost"` for a quiet one (×, "Clear"). Inputs, selects and
  textareas have their border, padding and focus ring. Don't restyle them unless the page needs something they are not.
- **Type**: a page title 20px/600, a section 16px/600, body 14px (line height 1.6, already set), meta 12–13px in
  `--pagent-muted`. Weights 400, 500, 600 only. Spacing in steps of 4 (4, 8, 12, 16, 24, 32).
- **A card** pads itself 16px (the chat's frame around it has no padding).

## Where to read more

Each chapter is a file next to this one, and `pagent docs <topic>` prints it (`pagent docs <topic>#<section>` one
section of it). This table is the complete list.

| When you are … | Read |
|---|---|
| titling a page, its language, a full-window page, the app's settings; layouts; rendering another node, keys, events; npm packages | [pages](references/pages.md) |
| data files; actions; secrets; another node's actions; page tools; `pagent run` | [data-actions](references/data-actions.md) |
| an agent's options, skills, MCP servers, session; agents telling each other; conversation surfaces | [agents](references/agents.md) |
| a node acting on its own (cron, every, a watched file, an agent's turns) | [triggers](references/triggers.md) |
| a page per address (`[id]`), its instances; changing one instance's code | [instances](references/instances.md) |
| driving a native Mac app | [bridges](references/bridges.md) |
| HTTP routes, `/mcp`, keys, other apps and their agents | [routes](references/routes.md) |
| showing a node in a conversation reply | [cards](references/cards.md) |
| a hook, a component's props, a type, `pagent/server` | [reference](references/reference.md) |
