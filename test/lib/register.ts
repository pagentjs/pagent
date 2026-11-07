// node --import ./test/lib/register.ts: lets tests import the bridge's .tsx files (Node strips TypeScript types but does
// not transform JSX). esbuild turns each into a plain ES module as it loads.
import { mkdtempSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

// And no test reads or writes the person's own pagent home (~/.pagent: their Grok Bot accounts, settings, daemon): what a
// test starts without a PAGENT_HOME of its own gets an empty one.
process.env.PAGENT_HOME ||= mkdtempSync(join(tmpdir(), "pagent-test-home-"));

registerHooks({
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".tsx")) return next(url, context);
    const file = fileURLToPath(url);
    const { code } = transformSync(readFileSync(file, "utf8"), { loader: "tsx", jsx: "automatic", format: "esm", sourcefile: file, sourcemap: "inline" });
    return { format: "module", source: code, shortCircuit: true };
  },
});
