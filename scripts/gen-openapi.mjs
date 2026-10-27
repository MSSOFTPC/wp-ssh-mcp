// Generates OpenAPI 3.1 files from the same spec the MCP server uses.
//   openapi.json       -> read + write actions (safe default, for ChatGPT Actions / n8n / agents)
//   openapi.full.json  -> everything, incl. files, write SQL, deletes, plugin (de)activation
// Usage: npm run build && npm run gen:openapi
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIONS, TIER_RANK } from "../dist/spec.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const schemaFor = (p) => {
  const base =
    p.type === "array" ? { type: "array", items: { type: p.items === "number" ? "number" : "string" } }
    : p.type === "any" ? {}
    : { type: p.type };
  return p.description ? { ...base, description: p.description } : base;
};

const pascal = (s) => s.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");

function build(maxTier) {
  // group specs by endpoint action name
  const byAction = new Map();
  for (const spec of ACTIONS) {
    if (TIER_RANK[spec.tier] > TIER_RANK[maxTier]) continue;
    if (!byAction.has(spec.action)) byAction.set(spec.action, []);
    byAction.get(spec.action).push(spec);
  }

  const schemas = {};
  const mapping = {};
  const refs = [];

  for (const [action, specs] of byAction) {
    // the riskiest variant provides the description
    const primary = specs.slice().sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
    const properties = {};
    const required = [];

    for (const s of specs) {
      for (const [k, p] of Object.entries(s.params)) {
        if (!properties[k]) properties[k] = schemaFor(p);
        if (p.required && specs.length === 1 && !required.includes(k)) required.push(k);
        if (p.required && specs.length > 1 && specs.every((x) => x.params[k]?.required) && !required.includes(k)) required.push(k);
      }
    }

    // forced params become explicit fields
    const fixedKeys = new Set(specs.flatMap((s) => Object.keys(s.fixed ?? {})));
    for (const k of fixedKeys) {
      const values = [...new Set(specs.map((s) => s.fixed?.[k]).filter((v) => v !== undefined))];
      if (values.length === 1) {
        properties[k] = { type: "boolean", enum: values, description: `Must be ${values[0]} for this action.` };
      } else {
        properties[k] = {
          type: "boolean",
          description: "true = preview only (always do this first); false = apply for real (needs the user's explicit approval).",
        };
      }
      if (!required.includes(k)) required.push(k);
    }

    const name = `${pascal(action)}Request`;
    schemas[name] = {
      type: "object",
      description: primary.description,
      required: ["action", ...(required.length ? ["params"] : [])],
      properties: {
        action: { type: "string", enum: [action] },
        params: {
          type: "object",
          properties,
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    // actions without params: params is optional/empty
    if (!Object.keys(properties).length) {
      schemas[name].properties.params = { type: "object", additionalProperties: false };
      schemas[name].required = ["action"];
    }
    mapping[action] = `#/components/schemas/${name}`;
    refs.push({ $ref: mapping[action] });
  }

  schemas.SuccessResponse = {
    type: "object",
    properties: { success: { type: "boolean" }, data: { description: "Action result" } },
  };
  schemas.ErrorResponse = {
    type: "object",
    properties: {
      code: { type: "string", example: "wp_ssh_bad_key" },
      message: { type: "string" },
      data: { type: "object", properties: { status: { type: "integer" } } },
    },
  };

  const safe = maxTier !== "full";
  return {
    openapi: "3.1.0",
    info: {
      title: "WP SSH: self-hosted AI bridge for WordPress",
      version: pkg.version,
      description:
        "Authenticated, scoped actions for managing a WordPress site you own. " +
        "Replace the server URL with your site. Send the secret key from Tools > WP SSH in the X-WPSSH-Key header. " +
        (safe
          ? "This file covers read and content-write actions only (no file writes, write SQL, deletes or plugin activation)."
          : "This file includes risky actions (file_write, write SQL, deletes, plugin activation). Only give it to agents you trust, and keep Read-only mode on in the plugin unless needed."),
      license: { name: "GPL-2.0-or-later", url: "https://www.gnu.org/licenses/gpl-2.0.html" },
    },
    servers: [{ url: "https://yoursite.com", description: "Replace with your own WordPress site (HTTPS only)" }],
    security: [{ WpSshKey: [] }],
    paths: {
      "/wp-json/wp-ssh/v1/execute": {
        post: {
          operationId: "execute",
          summary: "Run one WP SSH action",
          description:
            "Send {\"action\": \"<name>\", \"params\": {...}}. Start with site_info. Prefer read actions first; " +
            "ask the user before any change.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { oneOf: refs, discriminator: { propertyName: "action", mapping } },
              },
            },
          },
          responses: {
            200: { description: "Action result", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessResponse" } } } },
            401: { description: "Invalid or missing secret key", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            403: { description: "Bridge disabled, read-only mode, or IP not allowed", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            429: { description: "Locked out after failed attempts or rate limited" },
          },
        },
      },
      "/wp-json/wp-ssh/v1/ping": {
        get: {
          operationId: "ping",
          summary: "Check the plugin is installed (no key needed)",
          description: "Returns plugin, version, site and label.",
          security: [],
          responses: { 200: { description: "Plugin info" } },
        },
      },
    },
    components: {
      securitySchemes: { WpSshKey: { type: "apiKey", in: "header", name: "X-WPSSH-Key" } },
      schemas,
    },
  };
}

for (const [file, tier] of [["openapi.json", "write"], ["openapi.full.json", "full"]]) {
  const doc = build(tier);
  fs.writeFileSync(path.join(root, file), JSON.stringify(doc, null, 2) + "\n");
  console.log(`${file}: ${Object.keys(doc.components.schemas).length - 2} actions`);
}
