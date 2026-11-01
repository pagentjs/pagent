// A permission request to the app (contract.ts, PermissionRequest): the card a harness's question becomes. Over plain
// node:http, not fetch: the person may take an hour to answer, and fetch gives up on a response after five minutes.
import { request } from "node:http";
import type { PermissionAnswer, PermissionRequest } from "./contract.ts";

export function askApp(url: string, req: PermissionRequest, signal?: AbortSignal): Promise<PermissionAnswer> {
  return new Promise((resolve, reject) => {
    const r = request(url, { method: "POST", headers: { "content-type": "application/json" }, ...(signal ? { signal } : {}) }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data || "{}"));
        } catch (e) {
          reject(e);
        }
      });
    });
    r.on("error", reject);
    r.end(JSON.stringify(req));
  });
}
