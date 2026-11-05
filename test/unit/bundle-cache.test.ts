// A server file's build is kept in the OS temp folder and reused while its sources are unchanged. macOS clears that folder
// of files left unused for days, so a server up that long must build again rather than run a file that is gone.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bundleServerFile } from "../../packages/core/src/actions.ts";

const root = mkdtempSync(join(tmpdir(), "pagent-bundle-cache-"));
writeFileSync(join(root, "page.tsx"), `export default function Page() { return null; }\n`);
writeFileSync(join(root, "actions.ts"), `"use server";\nexport async function hi() { return "hi"; }\n`);
after(() => rmSync(root, { recursive: true, force: true }));

test("a build whose file the OS removed is built again", async () => {
  const src = join(root, "actions.ts");
  const first = await bundleServerFile(root, src);
  assert.ok(existsSync(first));
  assert.equal(await bundleServerFile(root, src), first, "unchanged sources reuse the build");
  rmSync(first);
  const again = await bundleServerFile(root, src);
  assert.ok(existsSync(again), "the build is written again");
});
