---
description: App bridges - a native Mac app as a node: installing one (pagent bridges, pagent add), writing one, the ax API (read, act, key, type, click, reopen, launch, watch, screenshot), app triggers, raw access (pagent app).
---

# App bridges: a native Mac app as a node

- [What a bridge is](#what-a-bridge-is)
- [Installing one](#installing-one)
- [Writing one](#writing-one)
- [Reading and acting: ax](#reading-and-acting-ax)
- [When the app is not running](#when-the-app-is-not-running)
- [Following the app without polling](#following-the-app-without-polling)
- [Raw access](#raw-access)
- [Combining a bridge's actions](#combining-a-bridges-actions)

## What a bridge is

One node per app, with `export const config = { shared: true, app: "Calculator" }`, its actions in `actions.ts`, a
hook for pages that only need its state, and a component for when the user wants to see it. No operator agent is
built in: a bridge node may declare its own agent (any harness or model the user trusts with that app) when it should
act on its own; that is a choice, not a layer. Only touch the app the bridge is for.

## Installing one

`pagent bridges` shows the ready-made bridges (the Mac app each drives, whether it is on this Mac, whether this app
has it already). `pagent add calculator` copies one into the app (`/calculator` by default; it never overwrites a
folder) and commits it; its `README.md` and `_agent.md` say what it does and what to be careful about; its actions
work at once (`pagent run /calculator --help`). For an app without a bridge, `pagent add --app TextEdit` creates a new
one: a skeleton with its own agent, which explores the app and writes the actions. An installed bridge is an ordinary
folder of the app (its `_source.json` says where it came from): you may change it.

## Writing one

Bridges are written by agents: explore the app with raw access (below), then freeze what works into actions, and keep
what you learned (ids, labels, quirks) in the bridge folder (`_agent.md`).

- **An app may say yes and do nothing** (a press on a Send button may report success and send nothing): after every
  step that matters, read back what should have changed, and throw when it did not.
- Before anything that cannot be undone (sending a message), check where you are (the open conversation) in code,
  right before, and keep such actions behind a setting the user controls (which chats may be written to).

## Reading and acting: ax

In a `"use server"` file, `import { ax } from "pagent/server"` reads and drives the app through the accessibility API,
in the background (it does not raise or focus it). The server's process needs Accessibility access.

```ts
// calculator/actions.ts
"use server";
import { ax } from "pagent/server";

/** Press Calculator's buttons by label, e.g. ["1", "Add", "2", "Equals"]; returns the texts its window shows. */
export async function press({ keys }: { keys: string[] }) {
  await ax.launch("Calculator");
  for (const label of keys) await ax.act("Calculator", { label, role: "Button" });
  return ax.flatten(await ax.read("Calculator")).filter((e) => e.role === "StaticText").map((e) => e.value);
}
```

- `await ax.read("Calculator")` → `{ window: tree, truncated }`: the app's main window (its largest standard window);
  elements `{ ref, role, id?, label?, value?, actions? }`. It stops after 800 elements or 5 s (`{ limit, seconds,
  depth }` to change).
- **Name elements by `id` when the app has them** (its AXIdentifier, a developer's name such as `#Equals` or
  `#message_field`; `#id` in `ax.format`): they do not move and do not change with the UI language. Else by label:
  `await ax.act("Calculator", "Equals")` or `{ label: "Equals", role: "Button" }`, or `{ id: "Equals" }` (found again
  on every call). `act(app, target, "set", "42")` sets a value, `"focus"` focuses. A `{ ref }` (child-index path)
  points elsewhere as soon as the window's layout changes: use one only right after the read that gave it, or for
  debugging.
- `await ax.key(app, "return", { target })` presses a key ("cmd+a", "escape", a letter) and `ax.type(app, "text", {
  target })` types, both posted to the app's process only, in the background; with a target, it is focused first and
  nothing is sent unless it took the focus.
- `await ax.click(app, target, { restore: true })` is a real mouse click, for what an app does only for a real one
  (some open a list item only so). It brings the app to the front (with `restore`, the app that was in front gets it
  back) and clicks only if the element on screen at that point is the target. Use it only when nothing else works, and
  say in the action's doc that it brings the app forward.
- `await ax.reopen(app, { restore: true })` shows the app's main window again, as a click on its Dock icon does, for
  when it is gone (closed, or replaced by another window: reads then come back empty). It brings the app to the front
  for a second or two. Don't build it into reads: throw a clear error that says what happened and offer `reopen` as an
  action, so whoever hit it decides.
- `ax.flatten(tree)` is every element of a window (or under an element) as one array, to search with `find` /
  `filter`: `ax.flatten(await ax.read("WeChat")).find((e) => e.id === "chat_message_list")`.
- `ax.format(tree)` is the tree as text for an agent (role, #id and label per line). `await
  ax.screenshot("Calculator")` is a PNG (base64) of the window; it needs Screen Recording access and throws saying so.

## When the app is not running

Reads and acts then fail ("Calculator is not running"). An action that needs the app starts it with `await
ax.launch("Calculator")` (in the background: it does not come to the front; it waits for the window; `{ launched }`
says whether this call started it). Don't launch from reads that run on their own (a trigger's check): they would
start the app over and over.

`config.quit: "after"` (optional; leave it out to never close the app) closes an app pagent launched again when the
turn that launched it ends (an agent's turn, a trigger's run; a page's click is nobody's turn, so what it launched
stays). An app the user had open is never closed.

## Following the app without polling

A trigger with `app` (only on the bridge node itself) keeps a data file following the app:
`export const triggers = { live: { app: true, run: "read" } }`, or `app: { id: "session_list" }` (only changes inside
that element, plus window-level ones). It runs `run` whenever the app's window changes (AXObserver; batched), once when
the app starts (or the server does), and never while it is not running. `every` on such a trigger is its fallback: it
polls only while the app runs but cannot be watched. Write the data file in that action (`data.write`); the pages'
`useData` and other triggers' `watch` follow it ([triggers](triggers.md)). Apps differ in what they report
(Calculator: every change of its display; WeChat: little, see its `_agent.md`): keep a Refresh by hand. In code,
`ax.watch(app, target?, (changes) => …)` is the same watch (it keeps a `"use server"` function's process alive until
`.stop()`).

## Raw access

Read and drive the app of a bridge (a node with `config.app`) directly: `pagent app read calculator`, `pagent app act
calculator "#Equals"` (by #id, label with `--role`, or `--ref`: press, set, focus, …), `pagent app key`, `pagent app
click`. Use the bridge's actions when they do the job; raw access is for the rest (and for writing new actions).

## Combining a bridge's actions

Deterministic code that combines a bridge's actions (a trigger's action, a reply that must always carry a marker) goes
in your node's own `"use server"` file, importing the bridge's: `import { press } from "~/calculator/actions"` (each
call runs on the bridge, as its action). Code keeps what must always hold (the marker, the one chat) out of the
agent's hands: the agent calls your action, and the rule is in it.
