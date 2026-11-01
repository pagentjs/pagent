---
description: Triggers (export const triggers) - cron, every, watch a data file, a bridge's app, an agent's turns and what it says outside them (TurnEvent) - running an action that wakes an agent with tell(); unattended runs; testing one.
---

# Triggers

- [When + an action](#when--an-action)
- [Turn triggers](#turn-triggers)
- [Waking an agent](#waking-an-agent)
- [How often it runs](#how-often-it-runs)
- [Unattended runs, and testing one](#unattended-runs-and-testing-one)

## When + an action

`export const triggers` makes the node act on its own. A trigger is when + an action of the node, `{ <when>, run:
"<action>" }` (the action: an exported function of its `"use server"` file, [data-actions](data-actions.md)):

```ts
// digest/actions.ts
"use server";
import { data, tell } from "pagent/server";

/** New mails since the last run: the triage agent hears about them once. */
export async function newMail() {
  const mails = data.read<{ id: string }[]>("inbox.json", []) ?? [];
  const seen = data.read<{ at: number }>("cursor.json", { at: 0 })?.at ?? 0;
  if (mails.length <= seen) return "nothing new";
  data.write("cursor.json", { at: mails.length });
  await tell("/digest#triage", `${mails.length - seen} new mails in inbox.json`);
}
```

```tsx
// digest/page.tsx
import type { Agents, Triggers } from "pagent";

export const agents = { triage: { cli: "claude" } } satisfies Agents;
export const triggers = { new: { watch: "inbox.json", run: "newMail" } } satisfies Triggers;

export default function Digest() {
  return <p>Mails are triaged as they come.</p>;
}
```

When:

- `cron: "*/10 * * * *"`;
- `every: "10s"` (also `"5m"`, `"1h"`): for polling local state, such as an app through a bridge, more often than once
  a minute;
- `watch: "inbox.json"`: a data file of this node (`"*.json"`; another node's by its path,
  `"~/worker/tasks.json"`);
- `app: true`: a bridge's app changed ([bridges](bridges.md#following-the-app-without-polling));
- `turn: "main"`: a turn of that agent of this node starts, and ends, or it says something outside a turn (`true`: any
  of its agents).

Something from outside (a CI job, a webhook of another service) comes in through a route instead
([routes](routes.md)).

## Turn triggers

A turn trigger's action gets the turn, `(e: TurnEvent)` from `"pagent"`: `{ phase: "start" | "end" | "message",
runId, messageId, agent, message, from, reply? }`:

- `message`: as it was given; `from`: who asked (`""` a person, else as "(from …)" names it); `reply`: at the end;
- `messageId`: the id the conversation shows the turn under (a `turnFooter`'s `turn.id`), during it and after a
  reload: key a record of the turn by it to show the record under its turn.

It runs for every turn of the agent, whoever started it and whether anyone watches (a helper made by `tell --new`, a
trigger's run, `pagent tell`), each start and end once and in order, and never for a turn its own action led to (it
may tell its agent). Record what a turn did there (a git snapshot before and after it, the cost of a run) rather than
in a page that may not be open.

`phase: "message"`: the agent said something outside any turn, which a harness that acts on its own does ([a Grok Bot
agent](agents.md#a-grok-bot-agent): a scheduled report, a reply after its turn ended, its answer to someone who wrote
to it in Grok Bot's own app). `reply` is what it said, once each. Answering a message, it carries that message and its
`from` (and, the app's, its turn's `runId` and `messageId`); on its own, `runId` and `message` are `""` and `from` is
the agent itself (`"/scout#scout"`). Route it from there:

```tsx
// scout/page.tsx
import type { Agents, Triggers } from "pagent";

export const agents = { scout: { cli: "grokbot", bot: "Scout", follow: "30m" } } satisfies Agents;
export const triggers = { said: { turn: "scout", run: "onScout" } } satisfies Triggers;

export default function Scout() {
  return <p>What Scout reports on its own goes to Ada.</p>;
}
// scout/actions.ts
"use server";
import type { TurnEvent } from "pagent";
import { tell } from "pagent/server";

export async function onScout(e: TurnEvent) {
  if (e.phase === "message" && !e.runId) await tell("/kai#kai", `Scout says:\n${e.reply}`);
}
```

## Waking an agent

The action is all the trigger does (code, no LLM): **it wakes an agent itself, when one should wake**, with
`tell("/inbox#triage", "…")` from `"pagent/server"` (the message says it comes from the trigger, `(from
trigger:/inbox#new)`). So write it to cost nothing and tell nobody when nothing changed (with `every` it runs every few
seconds: keep a cursor in a data file), and to tell once per new thing: an agent it tells may write the very file the
trigger watches, which runs the action again.

## How often it runs

A trigger never overlaps itself: a tick while it still runs is skipped; a change to what it watches while it runs runs
it again when it ends (up to three times in a row, then once more after a pause, then not until the next change). It
does not wait for the agent it told. Editing the app leaves an `every` counting; changing that trigger's declaration
starts its count over.

## Unattended runs, and testing one

Runs a trigger starts are unattended, and so are the runs they lead to (what such an agent delegates with `pagent
tell`, and the result coming back): nobody can approve or answer, so the agent does the work with file tools and leaves
a note in the data for the user. Declare what such an agent needs in its `allow` ([agents](agents.md#agent-options)).

`pagent tree` shows each trigger's last result. **To test one, run its action** (`pagent run /inbox newMail`: the same
code; a tell in it then comes from you, and its reply back to you).
