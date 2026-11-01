// Links and images in an agent's markdown (bridge/src/links.ts): the agent's text may say what a page it read told it to,
// so nothing in it loads or leaves the app on its own. A web link opens in a new tab when clicked; a page of the app in
// place, but never "//host" (another site, to a browser); an image loads only from the app itself or from the text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { imageKind, linkKind } from "../../packages/bridge/src/links.ts";

test("links: web, a page of the app, or neither (shown as code)", () => {
  assert.equal(linkKind("https://example.com/x"), "web");
  assert.equal(linkKind("http://example.com"), "web");
  assert.equal(linkKind("/reading"), "app");
  assert.equal(linkKind("/weather?city=Lisbon"), "app");
  assert.equal(linkKind("/"), "app");
  // Another site, to a browser: a scheme-relative address, or a backslash it reads as a slash.
  for (const href of ["//localhost/x", "//2130706433", "//evil.example/steal", "/\\evil.example", "/x\\y"]) assert.equal(linkKind(href), "none", href);
  // A local file's path, a file name, other schemes.
  for (const href of ["/Users/sam/notes.md", "/tmp/x", "/src/page.tsx", "page.tsx", "javascript:alert(1)", "mailto:a@b.c", ""]) assert.equal(linkKind(href), "none", href);
});

test("images: the app's own and data: ones show; another site's is a link (loading it would tell that site its address)", () => {
  const origin = "http://127.0.0.1:4870";
  assert.equal(imageKind("/_pagent/file?x=1", origin), "image");
  assert.equal(imageKind("http://127.0.0.1:4870/a.png", origin), "image");
  assert.equal(imageKind("chart.png", origin), "image");
  assert.equal(imageKind("data:image/png;base64,iVBORw0KGgo=", origin), "image");
  assert.equal(imageKind("https://x.example/?d=secret", origin), "link");
  assert.equal(imageKind("//x.example/p.gif", origin), "link");
  assert.equal(imageKind("http://127.0.0.1:9999/p.gif", origin), "link", "another port is another site");
  assert.equal(imageKind("/\\x.example/p.gif", origin), "link");
  assert.equal(imageKind("", origin), "none");
  assert.equal(imageKind("data:text/html,<b>x</b>", origin), "none");
  assert.equal(imageKind("ftp://x.example/p.gif", origin), "none");
});
