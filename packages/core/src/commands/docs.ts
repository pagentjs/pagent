// `pagent docs`: the engine skill and its chapters, from the engine running the app (docs.ts).
import { docs } from "../docs.ts";
import type { Command } from "./common.ts";

export const docsCommand: Command = {
  name: "docs",
  usage: "[topic[#section]]",
  about: "The pagent skill and its chapters, as this engine has them: without a topic, the topics; with one, that chapter; #section, one section of it.",
  more: "A section is a heading's anchor, or its start: pagent docs pages#metadata, pagent docs routes#keys. The same files are next to the skill's SKILL.md (references/).",
  run: async (_c, a) => docs(a.pos[0]),
};
