// Added to a phone's home screen, the app opens on its own (index.html, server.ts): the manifest is the page's it was
// added from, by that page's title; another device's start carries its key (a home screen's app has its own cookies);
// the icon is the app's icon.png, else pagent's.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { appId } from "../../packages/core/src/daemon-protocol.ts";
import { cookieName, localAddresses } from "../../packages/core/src/remote.ts";
import { testApp, type TestApp } from "../lib/app.ts";

const titled = (title: string) => `export const metadata = { title: ${JSON.stringify(title)} };\nexport default function P() { return null; }\n`;

describe("the app on a home screen", () => {
  const lan = localAddresses()[0];
  let app: TestApp;
  before(async () => {
    app = await testApp({ "page.tsx": titled("Office"), "meetings/page.tsx": titled("会议") }, lan ? { host: "0.0.0.0" } : {});
  });
  after(() => app.close());

  test("this machine: the page it was added from, by its title, as it is", async () => {
    const m = await (await fetch(`${app.url}/_pagent/manifest.webmanifest?start=${encodeURIComponent("/meetings")}`)).json();
    assert.equal(m.name, "会议 · Office");
    assert.equal(m.short_name, "会议");
    assert.equal(m.start_url, "/meetings");
    assert.equal(m.display, "standalone");
    assert.deepEqual(m.icons, [{ src: "/_pagent/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }]);
    const home = await (await fetch(`${app.url}/_pagent/manifest.webmanifest`)).json();
    assert.equal(home.name, "Office");
    assert.equal(home.start_url, "/");
    const shell = await (await fetch(`${app.url}/meetings`)).text();
    assert.match(shell, /apple-mobile-web-app-capable/);
    assert.match(shell, /rel="apple-touch-icon"/);
  });

  test("another device: its start carries its key; without the key, nothing", { skip: !lan && "no LAN address" }, async () => {
    const token = readFileSync(join(app.home, "state", appId(app.root), "owner-key"), "utf8").trim();
    const base = `http://${lan}:${new URL(app.url).port}`;
    assert.equal((await fetch(`${base}/_pagent/manifest.webmanifest?start=/meetings`)).status, 401);
    const m = await (await fetch(`${base}/_pagent/manifest.webmanifest?start=/meetings`, { headers: { cookie: `${cookieName(app.root)}=${token}` } })).json();
    assert.equal(m.start_url, `/meetings?token=${token}`);
    // The manifest's link carries the key (a home screen may fetch it without the cookie): served, not redirected.
    const linked = await fetch(`${base}/_pagent/manifest.webmanifest?start=/meetings&token=${token}`, { redirect: "manual" });
    assert.equal(linked.status, 200);
    assert.equal((await linked.json()).start_url, `/meetings?token=${token}`);
    // The page hands it on there (index.html); this machine's pages need none.
    assert.match(await (await fetch(`${base}/meetings`, { headers: { cookie: `${cookieName(app.root)}=${token}` } })).text(), new RegExp(`__PAGENT_KEY__ = "${token}"`));
    assert.doesNotMatch(await (await fetch(`${app.url}/meetings`)).text(), /__PAGENT_KEY__ =/);
    // Where a phone opens it: the QR code in the settings.
    const { urls } = await (await fetch(`${app.url}/_pagent/devices`)).json();
    assert.ok(urls.includes(`http://${lan}:${new URL(app.url).port}/?token=${token}`));
  });

  test("each app keeps its key in a cookie of its own (a browser keeps cookies by host, not port)", () => {
    assert.notEqual(cookieName("/apps/one"), cookieName("/apps/two"));
    assert.match(cookieName("/apps/one"), /^pagent_token_[0-9a-f]{10}$/);
  });

  test("the app's own icon.png, else pagent's", async () => {
    const own = (await fetch(`${app.url}/_pagent/icon.png`)).headers.get("content-type");
    assert.equal(own, "image/png");
    // A 2x3 PNG's header is enough for its size.
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(png);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(3, 20);
    writeFileSync(join(app.root, "icon.png"), png);
    const m = await (await fetch(`${app.url}/_pagent/manifest.webmanifest`)).json();
    assert.equal(m.icons[0].sizes, "2x3");
    assert.deepEqual(Buffer.from(await (await fetch(`${app.url}/_pagent/icon.png`)).arrayBuffer()), png);
  });
});
