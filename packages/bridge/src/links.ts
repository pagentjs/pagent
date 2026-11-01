// What a link or an image in an agent's markdown may do (chat.tsx). The text is the agent's, and an agent reads what it
// is given (a web page, a file, a message), which may tell it what to write: so nothing in it loads or goes anywhere
// on its own. A link goes where it says only when the person clicks it; an image loads only from the app itself (or is
// in the text: data:), any other is a link to it.

/**
 * A page of the app: "/reading", or with props: "/weather?city=Lisbon". Not "//host/x" nor "/\host" (another site, to a
 * browser), nor a local file's path (agents link to files by it: those are not pages).
 */
const appPage = /^\/(?![/\\])(?!(?:Users|Volumes|private|tmp|home|var|opt|etc|mnt)\/)[^\s.:?#\\]*(?:\?[^\s#]*)?$/;

/** Where a link goes: "web" (a new tab), "app" (a page of the app, in place), or "none" (shown as code: a path, …). */
export function linkKind(href: string): "web" | "app" | "none" {
  if (/^https?:\/\//i.test(href)) return "web";
  return appPage.test(href) ? "app" : "none";
}

/**
 * How an image shows: "image", when it comes from the app itself (`origin`: the page's) or is in the text (a data:
 * image); "link", any other web address (loading it would tell that site whatever its address carries); "none".
 */
export function imageKind(src: string, origin: string): "image" | "link" | "none" {
  if (!src.trim()) return "none";
  if (/^data:image\//i.test(src)) return "image";
  try {
    const url = new URL(src, origin + "/");
    if (url.origin === origin) return "image";
    return url.protocol === "http:" || url.protocol === "https:" ? "link" : "none";
  } catch {
    return "none";
  }
}
