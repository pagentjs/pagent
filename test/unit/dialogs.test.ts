// A dialog read off a TUI's screen (agents/dialogs.ts): the screens are Claude Code 2.1.304's as a terminal drew them
// (the folder-trust dialog, an AskUserQuestion, the model picker), and its autocompact offer as its code lays it out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keysFor, readDialog } from "../../packages/core/src/agents/dialogs.ts";

const RULE = "─".repeat(120);

test("an unnumbered choice: the folder-trust dialog", () => {
  const d = readDialog([
    "",
    RULE,
    " Accessing workspace:",
    "",
    " /private/tmp/app",
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " Security guide",
    "",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
  ]);
  assert.deepEqual(d, {
    title: "Accessing workspace:",
    text: "/private/tmp/app\nQuick safety check: Is this a project you created or one you trust?\nSecurity guide\nEnter to confirm · Esc to cancel",
    options: ["No, exit", "Yes, I trust this folder"],
    selected: 0,
  });
  assert.deepEqual(keysFor(d!, 1), ["\x1b[B", "\r"]);
  assert.deepEqual(keysFor(d!, 0), ["\r"]);
});

test("numbered choices with descriptions and a rule between them: a question (AskUserQuestion)", () => {
  const d = readDialog([
    " ▐▛███▛█   Claude Code v2.1.304",
    "",
    "❯ Use the AskUserQuestion tool to ask me one question: tea or coffee?",
    RULE,
    " ☐ Beverage",
    "",
    "Which do you prefer?",
    "",
    "❯ 1. Tea",
    "     Prefer tea",
    "  2. Coffee",
    "     Prefer coffee",
    "  3. Type something.",
    RULE,
    "  4. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ]);
  assert.equal(d?.title, "☐ Beverage");
  assert.equal(d?.text, "Which do you prefer?\nEnter to select · ↑/↓ to navigate · Esc to cancel");
  assert.deepEqual(d?.options, ["Tea", "Coffee", "Type something.", "Chat about this"]);
  assert.equal(d?.selected, 0);
  assert.deepEqual(keysFor(d!, 1), ["\x1b[B", "\r"]);
});

test("the choice selected need not be the first; a description beside a choice is not its name", () => {
  const d = readDialog([
    RULE,
    "  Select model",
    "  Switch between Claude models.",
    "",
    "    1. Default (recommended)  Use the default model (currently Opus 5.5)",
    "    2. Opus                   Opus 5.5 · Best for everyday, complex tasks",
    "    5. Haiku                  Haiku 5.5 · Fastest for quick answers ($0.50/$2.50 for prompts",
    "                              over 100k)",
    "  ❯ 6. Haiku 4.5 ✔            Newer version available",
    "",
    "  Enter to set as default · s to use this session only · Esc to cancel",
  ]);
  assert.deepEqual(d?.options, ["Default (recommended)", "Opus", "Haiku", "Haiku 4.5"]);
  assert.equal(d?.selected, 3);
  assert.equal(d?.title, "Select model");
  assert.deepEqual(keysFor(d!, 1), ["\x1b[A", "\x1b[A", "\r"]);
});

test("a product prompt: the autocompact offer", () => {
  const d = readDialog([
    "⏺ Done.",
    "",
    RULE,
    " We recommend compacting earlier",
    "",
    " Each message re-sends the whole conversation, so long conversations use up your plan's usage limits faster.",
    " Want to autocompact at 400k tokens instead? Your model doesn't change. Switch back any time with /autocompact.",
    "",
    " ❯ Autocompact at ‹ 400k › tokens",
    "   Keep 1M",
    "",
    " ↑/↓ choose · ←/→ change size · enter confirm · esc not now",
  ]);
  assert.equal(d?.title, "We recommend compacting earlier");
  assert.deepEqual(d?.options, ["Autocompact at ‹ 400k › tokens", "Keep 1M"]);
  assert.match(d!.text, /Want to autocompact at 400k tokens instead\?[\s\S]*esc not now$/);
});

test("inside a box; no choice marked: nothing to read", () => {
  const d = readDialog(["╭" + "─".repeat(40) + "╮", "│ Continue?                              │", "│ ❯ Yes                                  │", "│   No                                   │", "╰" + "─".repeat(40) + "╯"]);
  assert.deepEqual(d && { title: d.title, options: d.options }, { title: "Continue?", options: ["Yes", "No"] });
  assert.equal(readDialog(["[oh-my-zsh] Would you like to update? [Y/n]"]), null);
  assert.equal(readDialog([]), null);
});
