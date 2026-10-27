// End-to-end smoke test: mock WP SSH endpoint + real MCP client over stdio.
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

const seen = []; // requests that reached the mock
function mock(expectedKey, label) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/wp-json/wp-ssh/v1/ping") {
          return res.end(JSON.stringify({ plugin: "wp-ssh", version: "1.0", site: label, label }));
        }
        if (req.url === "/redirect/wp-json/wp-ssh/v1/execute") {
          res.statusCode = 301;
          res.setHeader("Location", "https://elsewhere.example/");
          return res.end();
        }
        if (req.headers["x-wpssh-key"] !== expectedKey) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ code: "wp_ssh_bad_key", message: "Invalid or missing secret key.", data: { status: 401 } }));
        }
        const parsed = JSON.parse(body);
        seen.push({ label, ...parsed });
        if (parsed.action === "option_get" && parsed.params?.name === "big") {
          return res.end(JSON.stringify({ success: true, data: "x".repeat(5000) }));
        }
        res.end(JSON.stringify({ success: true, data: { echo: parsed, site: label } }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { PATH: process.env.PATH, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const text = (r) => r.content.map((c) => c.text).join("\n");
let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

const A = await mock(KEY_A, "site-a");
const B = await mock(KEY_B, "site-b");

try {
  // ---------- 1. read mode (default) ----------
  console.log("read mode");
  let c = await connect({ WPSSH_URL: A.url, WPSSH_KEY: KEY_A });
  let names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("site_info") && names.includes("post_list") && names.includes("wpssh_ping"));
  assert.ok(!names.includes("post_create"), "write tool must be hidden in read mode");
  assert.ok(!names.includes("file_write") && !names.includes("db_query_write"), "full tools hidden in read mode");
  ok(`only read tools exposed (${names.length} tools)`);

  const tools = (await c.listTools()).tools;
  assert.equal(tools.find((t) => t.name === "site_info").annotations.readOnlyHint, true);
  ok("read tools carry readOnlyHint");

  let r = await c.callTool({ name: "site_info", arguments: {} });
  assert.ok(!r.isError);
  assert.equal(seen.at(-1).action, "site_info");
  ok("site_info reaches the endpoint with the key");

  r = await c.callTool({ name: "wpssh_ping", arguments: {} });
  assert.match(text(r), /site-a/);
  ok("wpssh_ping works without a key");

  r = await c.callTool({ name: "wpssh_sites", arguments: {} });
  assert.ok(!text(r).includes(KEY_A), "key must never be shown");
  ok("wpssh_sites never leaks the key");

  // SQL guards
  for (const bad of ["DELETE FROM wp_posts", "SELECT 1; DROP TABLE wp_users", "UPDATE wp_options SET option_value=1", "SELECT * FROM t INTO OUTFILE '/tmp/x'"]) {
    const before = seen.length;
    r = await c.callTool({ name: "db_query", arguments: { sql: bad } });
    assert.ok(r.isError, `should block: ${bad}`);
    assert.equal(seen.length, before, "blocked SQL must not reach the site");
  }
  ok("db_query blocks writes / multi-statement / OUTFILE client-side");

  r = await c.callTool({ name: "db_query", arguments: { sql: "SELECT ID FROM wp_posts LIMIT 5;" } });
  assert.ok(!r.isError);
  ok("db_query allows a single SELECT");

  r = await c.callTool({ name: "search_replace_preview", arguments: { search: "a", replace: "b", dry_run: false } });
  assert.equal(seen.at(-1).params.dry_run, true);
  ok("search_replace_preview always sends dry_run=true (model cannot override)");

  // undefined params are dropped
  await c.callTool({ name: "post_list", arguments: { limit: 3 } });
  assert.deepEqual(seen.at(-1).params, { limit: 3 });
  ok("optional params that are not set are not sent");
  await c.close();

  // ---------- 2. wrong key ----------
  console.log("errors");
  c = await connect({ WPSSH_URL: A.url, WPSSH_KEY: "wrong" });
  r = await c.callTool({ name: "site_info", arguments: {} });
  assert.ok(r.isError);
  assert.match(text(r), /wrong or missing secret key/i);
  ok("401 becomes a clear error with a hint");
  await c.close();

  c = await connect({ WPSSH_URL: A.url + "/redirect", WPSSH_KEY: KEY_A });
  r = await c.callTool({ name: "site_info", arguments: {} });
  assert.ok(r.isError);
  assert.match(text(r), /redirect/i);
  ok("redirects are refused (key is not forwarded)");
  await c.close();

  c = await connect({ WPSSH_URL: "http://127.0.0.1:1", WPSSH_KEY: KEY_A });
  r = await c.callTool({ name: "site_info", arguments: {} });
  assert.ok(r.isError);
  assert.match(text(r), /Could not reach/);
  ok("unreachable site gives a readable error");
  await c.close();

  // ---------- 3. write + full modes ----------
  console.log("write / full modes");
  c = await connect({ WPSSH_URL: A.url, WPSSH_KEY: KEY_A, WPSSH_MODE: "write" });
  names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("post_create") && names.includes("order_update_status"));
  assert.ok(!names.includes("file_write") && !names.includes("post_delete") && !names.includes("search_replace") && !names.includes("plugin_deactivate"));
  ok("write mode: content tools yes, risky tools still hidden");
  await c.close();

  c = await connect({ WPSSH_URL: A.url, WPSSH_KEY: KEY_A, WPSSH_MODE: "full" });
  const full = (await c.listTools()).tools;
  names = full.map((t) => t.name);
  for (const n of ["file_write", "file_restore", "post_delete", "db_query_write", "search_replace", "plugin_activate"]) assert.ok(names.includes(n), n);
  assert.equal(full.find((t) => t.name === "file_write").annotations.destructiveHint, true);
  ok(`full mode: risky tools exposed and marked destructive (${names.length} tools)`);

  r = await c.callTool({ name: "search_replace", arguments: { search: "x", replace: "y" } });
  assert.equal(seen.at(-1).params.dry_run, false);
  ok("search_replace sends dry_run=false only in full mode");

  r = await c.callTool({ name: "db_query_write", arguments: { sql: "UPDATE wp_options SET option_value='1' WHERE option_id=1", confirm: true } });
  assert.equal(seen.at(-1).action, "db_query");
  assert.equal(seen.at(-1).params.confirm, true);
  ok("db_query_write maps to the db_query action");

  // missing required param is rejected by schema, nothing sent
  const before = seen.length;
  r = await c.callTool({ name: "file_restore", arguments: { path: "themes/x/style.css" } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.ok(r.isError);
  assert.equal(seen.length, before);
  ok("file_restore without required confirm is rejected before any request");
  await c.close();

  // ---------- 4. multi-site ----------
  console.log("multi-site");
  c = await connect({
    WPSSH_SITES: JSON.stringify([
      { name: "shop", url: A.url, key: KEY_A },
      { name: "blog", url: B.url, key: KEY_B },
    ]),
  });
  const ms = (await c.listTools()).tools;
  const schema = ms.find((t) => t.name === "site_info").inputSchema;
  assert.ok(schema.properties.site && schema.required.includes("site"));
  ok("site parameter is required when several sites are configured");

  r = await c.callTool({ name: "site_info", arguments: { site: "blog" } });
  assert.match(text(r), /site-b/);
  r = await c.callTool({ name: "site_info", arguments: { site: "shop" } });
  assert.match(text(r), /site-a/);
  ok("calls are routed to the right site with the right key");
  await c.close();

  // ---------- 5. output truncation ----------
  console.log("limits");
  c = await connect({ WPSSH_URL: A.url, WPSSH_KEY: KEY_A, WPSSH_MODE: "full", WPSSH_MAX_CHARS: "1000" });
  r = await c.callTool({ name: "option_get", arguments: { name: "x" } }); // normal
  assert.ok(!r.isError);
  assert.ok(!text(r).includes("truncated"));
  ok("normal responses pass through untouched");
  r = await c.callTool({ name: "option_get", arguments: { name: "big" } });
  assert.match(text(r), /output truncated/);
  assert.ok(text(r).length < 1500);
  ok("huge responses are truncated with a hint to narrow the query");
  await c.close();

  // ---------- 6. https enforcement ----------
  console.log("config");
  const t = new StdioClientTransport({
    command: process.execPath, args: [ENTRY],
    env: { PATH: process.env.PATH, WPSSH_URL: "http://example.com", WPSSH_KEY: KEY_A }, stderr: "pipe",
  });
  const c2 = new Client({ name: "smoke", version: "0.0.0" });
  await assert.rejects(() => c2.connect(t));
  ok("plain http:// to a remote host is refused at startup");
} finally {
  A.srv.close();
  B.srv.close();
}

console.log(`\nAll good: ${passed} checks passed.`);
