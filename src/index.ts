#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, loadConfig, VERSION } from "./server.js";

const HELP = `wp-ssh-mcp ${VERSION}
MCP server for the WP SSH WordPress plugin (self-hosted AI bridge).

Environment variables
  WPSSH_URL           Site URL, e.g. https://example.com
  WPSSH_KEY           Secret key from WordPress > Tools > WP SSH
  WPSSH_NAME          Optional site name (default: "default")
  WPSSH_SITES         JSON array for several sites: [{"name":"shop","url":"https://...","key":"..."}]
  WPSSH_MODE          read (default) | write | full
  WPSSH_ALLOW_HTTP    Set to 1 to allow plain http:// (trusted networks only)
  WPSSH_TIMEOUT_MS    Request timeout, default 30000
  WPSSH_MAX_CHARS     Max characters returned per call, default 60000

Never put the key in a shared config file or repo.`;

async function main() {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") {
    console.log(HELP);
    return;
  }
  if (arg === "--version" || arg === "-v") {
    console.log(VERSION);
    return;
  }

  const cfg = loadConfig();
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stdout is reserved for the MCP protocol; errors go to stderr
  process.stderr.write(`[wp-ssh-mcp] ${err?.message ?? err}\n`);
  process.exit(1);
});
