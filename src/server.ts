import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ACTIONS, TIER_RANK, type ActionSpec, type ParamSpec, type Tier } from "./spec.js";

export interface Site {
  name: string;
  url: string;
  key: string;
}

export interface Config {
  sites: Site[];
  mode: Tier;
  timeoutMs: number;
  maxChars: number;
}

export const VERSION = "0.1.0";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

function normalizeUrl(raw: string, allowHttp: boolean): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid site URL: "${raw}"`);
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(allowHttp || isLocal)) {
    throw new Error(
      `Refusing non-HTTPS URL "${u.origin}". The secret key would travel in clear text. ` +
        `Use https:// (or set WPSSH_ALLOW_HTTP=1 for a trusted private network).`,
    );
  }
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowHttp = env.WPSSH_ALLOW_HTTP === "1";
  const sites: Site[] = [];

  if (env.WPSSH_SITES) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.WPSSH_SITES);
    } catch {
      throw new Error("WPSSH_SITES must be valid JSON: [{\"name\":\"shop\",\"url\":\"https://...\",\"key\":\"...\"}]");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("WPSSH_SITES must be a non-empty array.");
    for (const s of parsed as Array<Partial<Site>>) {
      if (!s?.name || !s.url || !s.key) throw new Error("Each WPSSH_SITES entry needs name, url and key.");
      sites.push({ name: String(s.name), url: normalizeUrl(String(s.url), allowHttp), key: String(s.key) });
    }
  } else if (env.WPSSH_URL && env.WPSSH_KEY) {
    sites.push({ name: env.WPSSH_NAME || "default", url: normalizeUrl(env.WPSSH_URL, allowHttp), key: env.WPSSH_KEY });
  } else {
    throw new Error(
      "No site configured. Set WPSSH_URL and WPSSH_KEY (one site) or WPSSH_SITES (several sites). See the README.",
    );
  }

  const names = new Set(sites.map((s) => s.name));
  if (names.size !== sites.length) throw new Error("Site names in WPSSH_SITES must be unique.");

  const mode = (env.WPSSH_MODE || "read").toLowerCase();
  if (!["read", "write", "full"].includes(mode)) throw new Error('WPSSH_MODE must be "read", "write" or "full".');

  return {
    sites,
    mode: mode as Tier,
    timeoutMs: Number(env.WPSSH_TIMEOUT_MS) || 30_000,
    maxChars: Number(env.WPSSH_MAX_CHARS) || 60_000,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                         */
/* ------------------------------------------------------------------ */

export interface CallResult {
  ok: boolean;
  text: string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n\n[... output truncated: ${text.length - max} more characters. Ask for a narrower result (limit, search, specific id/path).]`
  );
}

async function request(
  cfg: Config,
  url: string,
  init: RequestInit,
): Promise<CallResult> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs), redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        text: `Site answered with a redirect (HTTP ${res.status}) to ${res.headers.get("location") ?? "?"}. ` +
          `The key is not forwarded on redirects. Fix the site URL (e.g. https vs http, www vs non-www).`,
      };
    }
    const raw = await res.text();
    let pretty = raw;
    let body: any;
    try {
      body = JSON.parse(raw);
      pretty = JSON.stringify(body, null, 2);
    } catch {
      /* not JSON */
    }
    const apiOk =
      res.ok && !(body && typeof body === "object" && (body.success === false || (body.code && body.message && body.success !== true)));
    if (!apiOk) {
      const hint =
        res.status === 401 ? "\nHint: wrong or missing secret key, or the key was regenerated." :
        res.status === 403 ? "\nHint: the bridge may be disabled, Read-only mode may be on, or your IP is not on the allowlist." :
        res.status === 404 ? "\nHint: is the WP SSH plugin active and the URL correct?" :
        res.status === 429 ? "\nHint: locked out or rate limited. Wait a few minutes." : "";
      return { ok: false, text: truncate(`HTTP ${res.status}\n${pretty}${hint}`, cfg.maxChars) };
    }
    return { ok: true, text: truncate(pretty, cfg.maxChars) };
  } catch (err: any) {
    const msg = err?.name === "TimeoutError" ? `Request timed out after ${cfg.timeoutMs} ms.` : String(err?.message ?? err);
    return { ok: false, text: `Could not reach the site: ${msg}` };
  }
}

export function callAction(cfg: Config, site: Site, action: string, params: Record<string, unknown>) {
  return request(cfg, `${site.url}/wp-json/wp-ssh/v1/execute`, {
    method: "POST",
    headers: { "X-WPSSH-Key": site.key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ action, params }),
  });
}

export function ping(cfg: Config, site: Site) {
  return request(cfg, `${site.url}/wp-json/wp-ssh/v1/ping`, { method: "GET", headers: { Accept: "application/json" } });
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/** Conservative check: exactly one read-only statement. */
export function isReadOnlySql(sql: string): boolean {
  const s = sql.trim().replace(/;+\s*$/, "");
  if (!s || s.includes(";")) return false;
  if (/\binto\s+(outfile|dumpfile)\b/i.test(s)) return false;
  return /^(select|show|describe|desc|explain)\b/i.test(s);
}

/* ------------------------------------------------------------------ */
/* zod from spec                                                       */
/* ------------------------------------------------------------------ */

function zodFor(p: ParamSpec): z.ZodTypeAny {
  let t: z.ZodTypeAny;
  switch (p.type) {
    case "string": t = z.string(); break;
    case "number": t = z.number(); break;
    case "boolean": t = z.boolean(); break;
    case "object": t = z.record(z.string(), z.any()); break;
    case "array": t = z.array(p.items === "number" ? z.number() : z.string()); break;
    default: t = z.any();
  }
  if (p.description) t = t.describe(p.description);
  return p.required ? t : t.optional();
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

function textResult(r: CallResult) {
  return { content: [{ type: "text" as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
}

export function createServer(cfg: Config): McpServer {
  const server = new McpServer({ name: "wp-ssh-mcp", version: VERSION });
  const multi = cfg.sites.length > 1;
  const byName = new Map(cfg.sites.map((s) => [s.name, s]));
  const siteNames = cfg.sites.map((s) => s.name);

  const siteShape: Record<string, z.ZodTypeAny> = multi
    ? { site: z.enum(siteNames as [string, ...string[]]).describe(`Which site to use. One of: ${siteNames.join(", ")}`) }
    : {};

  const resolveSite = (name: unknown): Site => (multi ? byName.get(String(name))! : cfg.sites[0]);

  // --- helper tools ---
  server.registerTool(
    "wpssh_sites",
    {
      title: "List configured sites",
      description: `List the WordPress sites this server can reach and the current safety mode ("${cfg.mode}"). Never shows keys.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify({ mode: cfg.mode, sites: cfg.sites.map((s) => ({ name: s.name, url: s.url })) }, null, 2),
      }],
    }),
  );

  server.registerTool(
    "wpssh_ping",
    {
      title: "Ping site",
      description: "Check that the WP SSH plugin is installed and reachable (no key needed). Returns plugin, version, site, label.",
      inputSchema: siteShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: any) => textResult(await ping(cfg, resolveSite(args?.site))),
  );

  // --- action tools ---
  let registered = 0;
  for (const spec of ACTIONS) {
    if (TIER_RANK[spec.tier] > TIER_RANK[cfg.mode]) continue; // hidden in this mode
    registerAction(server, cfg, spec, siteShape, resolveSite);
    registered++;
  }

  process.stderr.write(
    `[wp-ssh-mcp] ${cfg.sites.length} site(s), mode=${cfg.mode}, ${registered + 2} tools registered\n`,
  );
  return server;
}

function registerAction(
  server: McpServer,
  cfg: Config,
  spec: ActionSpec,
  siteShape: Record<string, z.ZodTypeAny>,
  resolveSite: (name: unknown) => Site,
) {
  const shape: Record<string, z.ZodTypeAny> = { ...siteShape };
  for (const [k, p] of Object.entries(spec.params)) shape[k] = zodFor(p);

  const isRead = spec.tier === "read";
  const tierNote =
    spec.tier === "read" ? "" : spec.tier === "write" ? " [changes site content]" : " [RISKY: ask the user before using]";

  server.registerTool(
    spec.tool,
    {
      title: spec.tool,
      description: `${spec.description}${tierNote}`,
      inputSchema: shape,
      annotations: {
        readOnlyHint: isRead,
        destructiveHint: spec.tier === "full",
        idempotentHint: isRead,
        openWorldHint: true,
      },
    },
    async (args: Record<string, unknown>) => {
      const { site: siteName, ...rest } = args;
      const site = resolveSite(siteName);

      // drop undefined, then apply forced params last (model cannot override)
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) params[k] = v;
      Object.assign(params, spec.fixed ?? {});

      // client-side SQL guard for the read-only tool
      if (spec.tool === "db_query" && !isReadOnlySql(String(params.sql ?? ""))) {
        return textResult({
          ok: false,
          text: "db_query only accepts ONE read-only statement (SELECT / SHOW / DESCRIBE / EXPLAIN). " +
            "For writes use db_query_write (needs WPSSH_MODE=full and user approval).",
        });
      }

      return textResult(await callAction(cfg, site, spec.action, params));
    },
  );
}
