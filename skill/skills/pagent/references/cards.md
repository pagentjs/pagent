---
description: Cards - showing a node of the app inside a conversation reply (a fenced pagent block), when to, reusing a node, writing a new card node to be shown again.
---

# Cards: a node in a reply

When you talk with someone in a conversation surface (`<AgentConsole>`, `<Chat>`, `<AgentBar>`), you can show a node
of the app inside your reply: a **card**. It is the node itself, live (its data, its buttons, its agent), with an
"Open" link to its own page. Write a fenced block with the language `pagent`, one card per line: the node's path, then
its props as a JSON object (optional):

````md
Here is this week:

```pagent
/cards/todo {"title": "This week", "list": "week-42"}
```
````

The reply stays plain text (a terminal shows the block as it is; the transcript is the history, so old cards render
again after a reload). A path with no node shows a small placeholder. There is no other way to put UI in a reply, and
no need for one: never paste HTML.

- **When**: the answer is better to look at or act on than to read (a list to tick off, a table, a chart, a form, a
  comparison). A fact, an explanation or a question back is text.
- **Reuse first**: `pagent tree` lists the nodes; show an existing one with other props before writing a new one.
- **A new card** is an ordinary node, usually under the conversation's own folder, `cards/<slug>/` (a short, plain
  name for what it shows, not for this one answer: `todo`, `weather`, `compare`). Write it to be shown again:
  - What changes from one answer to the next is a **prop** with a sensible default (`city`, `title`, `days`). Props
    are small values; anything long is data.
  - What the user changes (ticks, entries) is **data**, in the card's folder. When each use needs its own (two lists),
    a prop names the file (below). Write with an updater, as always.
  - It is shown in a column about 700px wide and up to about 480px high, and full size when opened: size it to its
    content (no `100vh`), no page chrome, a short title.
  - Check it with `pagent status /cards/<slug>` before you reply; you may show it on screen with `pagent screen open`.
- A card's "Open" link opens its page with the same props, in its URL's query ([pages](pages.md#a-pages-props-come-from-where-it-is-shown)).

```tsx
// cards/todo/page.tsx
import { useData } from "pagent";

type Item = { text: string; done: boolean };

export const metadata = { title: "To do" };

export default function Todo({ title = "To do", list = "default" }: { title?: string; list?: string }) {
  const [items = [], setItems] = useData<Item[]>(list + ".json", []);
  const toggle = (i: number) => setItems((prev) => prev.map((x, j) => (j === i ? { ...x, done: !x.done } : x)));
  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 600 }}>{title}</h3>
      {items.map((x, i) => (
        <label key={i} style={{ display: "block" }}>
          <input type="checkbox" checked={x.done} onChange={() => toggle(i)} /> {x.text}
        </label>
      ))}
    </div>
  );
}
```
