# wp-ssh-mcp: WordPress MCP server for the WP SSH plugin

![Demo](https://raw.githubusercontent.com/MSSOFTPC/wp-ssh-mcp/main/assets/demo.gif)

![License: GPL v2+](https://img.shields.io/badge/license-GPLv2%2B-blue)
![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Self-hosted](https://img.shields.io/badge/third--party%20server-none-brightgreen)

Let **Claude, Cursor, Claude Code** and other MCP clients manage your **self-hosted WordPress** site (posts, WooCommerce, Elementor, diagnostics, files) **without SSH access**.

`wp-ssh-mcp` is a small program that runs **on your own computer**. It turns the [WP SSH plugin](https://github.com/MSSOFTPC/wp-ssh)'s HTTPS endpoint into MCP tools, so your AI sees `post_list`, `order_get`, `elementor_data_set` and so on, with proper parameter schemas. No hosted relay, no accounts: your key stays on your machine.

> **This needs two pieces.** The WordPress plugin does the real work on your site; `wp-ssh-mcp` only connects your AI app to it.

```
Claude Desktop / Cursor / Claude Code
        │   MCP (local, stdio)
        ▼
   wp-ssh-mcp                 ← this repo, runs on your computer
        │   HTTPS + X-WPSSH-Key
        ▼
   your WordPress site        ← WP SSH plugin (separate repo)
```

## Quick start

**Step 1: install the plugin on your WordPress site** (once per site)

1. Get it from [MSSOFTPC/wp-ssh](https://github.com/MSSOFTPC/wp-ssh) (Releases → `wp-ssh.zip`).
2. WordPress admin: **Plugins → Add New → Upload Plugin → Activate**.
3. **Tools → WP SSH**: tick **Enable bridge**, copy the **Secret key**.

**Step 2: connect your AI app** (see [Install](#install) for Claude Desktop, Claude Code and Cursor)

```bash
claude mcp add my-site -e WPSSH_URL=https://yoursite.com -e WPSSH_KEY=your-key -- npx -y wp-ssh-mcp
```

Then ask: *"Run diagnostics on my site."*

## Safe by default

The server starts in **read mode**. Write tools are not even shown to the AI until you opt in.

| `WPSSH_MODE` | What the AI can do | Action tools |
|---|---|---|
| `read` (default) | Look, never touch: site info, diagnostics, posts, orders, options, file reads, SELECT queries, dry-run search-replace, Elementor export | 21 |
| `write` | + content changes: create/update posts, order status, Elementor data/import, product attributes, cache clear, media upload, menus | 34 |
| `full` | + risky: file writes/restore, write SQL, permanent delete, real search-replace, plugin activate/deactivate | 41 |

More safety built in:

- Risky tools are marked **destructive**, so MCP clients show an approval prompt.
- `db_query` accepts **one read-only statement** only. Writes need the separate `db_query_write` tool (full mode).
- `search_replace_preview` always sends `dry_run: true`; the model cannot override it.
- `confirm: true` is **never added automatically**. The model must pass it, and tool descriptions tell it to do so only after your approval.
- The plugin's own protections still apply (Read-only mode, IP allowlist, lockout, auto-backups, activity log).
- Refuses plain `http://` (except localhost), refuses to follow redirects (the key is never forwarded), and never prints your key.

## Install

Requires Node.js 18+ and the WP SSH plugin active on your site (**Tools → WP SSH** → copy the secret key, tick **Enable bridge**).

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "my-site": {
      "command": "npx",
      "args": ["-y", "wp-ssh-mcp"],
      "env": {
        "WPSSH_URL": "https://yoursite.com",
        "WPSSH_KEY": "your-64-char-secret-key",
        "WPSSH_MODE": "read"
      }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add my-site -e WPSSH_URL=https://yoursite.com -e WPSSH_KEY=your-key -- npx -y wp-ssh-mcp
```

### Cursor

`~/.cursor/mcp.json` (or project `.cursor/mcp.json`): same `mcpServers` block as above.

### Several sites

```json
"env": {
  "WPSSH_SITES": "[{\"name\":\"shop\",\"url\":\"https://shop.com\",\"key\":\"...\"},{\"name\":\"blog\",\"url\":\"https://blog.com\",\"key\":\"...\"}]",
  "WPSSH_MODE": "read"
}
```

Every tool then gets a required `site` parameter (`shop` or `blog`).

### Run from source

```bash
git clone https://github.com/MSSOFTPC/wp-ssh-mcp
cd wp-ssh-mcp
npm install && npm run build
# then use  "command": "node", "args": ["/full/path/to/wp-ssh-mcp/dist/index.js"]
```

## Configuration

| Variable | Meaning |
|---|---|
| `WPSSH_URL`, `WPSSH_KEY` | One site. URL like `https://example.com`, key from Tools → WP SSH |
| `WPSSH_NAME` | Optional name for the single site (default `default`) |
| `WPSSH_SITES` | JSON array for several sites (see above) |
| `WPSSH_MODE` | `read` (default), `write`, `full` |
| `WPSSH_ALLOW_HTTP` | `1` to allow `http://` on a trusted private network |
| `WPSSH_TIMEOUT_MS` | Request timeout, default `30000` |
| `WPSSH_MAX_CHARS` | Max characters returned per call (default `60000`). Big Elementor pages are truncated with a hint |

## Example prompts

- "Run diagnostics on my site and tell me what is slowing it down."
- "List draft posts tagged ready and show me before publishing any."
- "Preview a search-replace from `http://old.com` to `https://new.com`. Don't apply it."
- "Export the Elementor design of page 120 from `shop` and import it as a draft on `blog`."
- "Show today's WooCommerce orders and summarise by status."

## ChatGPT, n8n, Make, Zapier (no MCP needed)

This repo also ships OpenAPI 3.1 files generated from the same action list:

- `openapi.json`: read + content-write actions (use this one)
- `openapi.full.json`: everything, including risky actions (only for agents you fully trust)

**Custom GPT:** Configure → Actions → Import the file → set the server URL to your site → Authentication: *API Key*, *Custom*, header name `X-WPSSH-Key`.
Note that ChatGPT calls your site from OpenAI's servers, so an IP allowlist is not practical there; keep the plugin in Read-only mode unless you are actively making changes.

Regenerate after changing `src/spec.ts`: `npm run build && npm run gen:openapi`.

## Privacy

`wp-ssh-mcp` talks only to the site URLs you configure. No telemetry, no analytics, no third-party servers. What the AI sees is the output of the tools you allow, and it is handled under your AI provider's terms.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "wrong or missing secret key" | Re-copy the key from Tools → WP SSH (regenerating invalidates the old one) |
| 403 | Bridge disabled, Read-only mode on in the plugin, or your IP is not on the allowlist |
| 404 | Plugin inactive, or permalinks/REST API blocked by a security plugin or server rule |
| "redirect" error | Use the exact final URL (https vs http, www vs non-www) |
| Tools missing | You are in `read` mode; set `WPSSH_MODE=write` or `full` and restart the client |
| Nothing shows in Claude Desktop | Check JSON syntax, fully restart the app, run `npx wp-ssh-mcp --help` in a terminal |

## Development

```bash
npm install
npm test            # builds and runs the end-to-end smoke test against a mock endpoint
npm run gen:openapi
```

`src/spec.ts` is the single list of actions. Add an action there and both the MCP tool and the OpenAPI schema appear.

## License

GPL-2.0-or-later, same as the plugin.
