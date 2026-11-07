// Whether a page fills the window (metadata.fill, /_pagent/route): its own say, else the nearest layout above it that
// says. A page above it does not say for it: a home page that fills had made every page under it fill too (no scroll),
// once the home node had a layout (only nodes with one are in a route, and a node's declarations were its layout's and
// its page's in one).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { testApp, type TestApp } from "../lib/app.ts";

const page = (fill?: boolean) => `${fill === undefined ? "" : `export const metadata = { fill: ${fill} };\n`}export default function Page() { return <div />; }\n`;
const layout = (fill?: boolean) => `${fill === undefined ? "" : `export const metadata = { fill: ${fill} };\n`}export default function Layout({ children }) { return <>{children}</>; }\n`;

describe("a page that fills the window", () => {
  let app: TestApp;
  const fills = (path: string) => app.get<{ fill: boolean }>(`/_pagent/route?path=${encodeURIComponent(path)}`).then((r) => r.fill);

  before(async () => {
    app = await testApp({
      "layout.tsx": layout(),
      "page.tsx": page(true),
      "board/layout.tsx": layout(),
      "notes/page.tsx": page(),
      "board/page.tsx": page(false),
      "board/day/page.tsx": page(),
      "studio/layout.tsx": layout(true),
      "studio/page.tsx": page(),
      "studio/doc/page.tsx": page(),
      "studio/doc/plain/page.tsx": page(false),
    });
  });
  after(() => app.close());

  test("its own say; a page above it does not say for it", async () => {
    assert.equal(await fills("/"), true);
    assert.equal(await fills("/notes"), false, "the home page fills, not the pages under it");
    assert.equal(await fills("/board/day"), false);
  });

  test("a layout says for every page under it, until one says otherwise", async () => {
    assert.equal(await fills("/studio"), true);
    assert.equal(await fills("/studio/doc"), true);
    assert.equal(await fills("/studio/doc/plain"), false);
  });
});
