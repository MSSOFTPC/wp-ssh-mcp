/**
 * Single source of truth for every WP SSH action.
 * Used by:
 *   - src/index.ts          -> registers MCP tools
 *   - scripts/gen-openapi   -> generates openapi.json
 *
 * Tiers (WPSSH_MODE):
 *   read  = look but don't touch (default)
 *   write = content-level changes (posts, orders, Elementor, cache ...)
 *   full  = risky: files, write SQL, deletes, restore, plugin (de)activation, real search-replace
 */

export type Tier = "read" | "write" | "full";
export type ParamType = "string" | "number" | "boolean" | "object" | "array" | "any";

export interface ParamSpec {
  type: ParamType;
  required?: boolean;
  description?: string;
  items?: "string" | "number";
}

export interface ActionSpec {
  /** MCP tool name */
  tool: string;
  /** Action name sent to the WP SSH endpoint */
  action: string;
  tier: Tier;
  group: string;
  description: string;
  params: Record<string, ParamSpec>;
  /** Params that the wrapper forces (the model cannot override them) */
  fixed?: Record<string, unknown>;
}

const str = (description: string, required = false): ParamSpec => ({ type: "string", required, description });
const num = (description: string, required = false): ParamSpec => ({ type: "number", required, description });
const bool = (description: string, required = false): ParamSpec => ({ type: "boolean", required, description });
const obj = (description: string, required = false): ParamSpec => ({ type: "object", required, description });
const any = (description: string, required = false): ParamSpec => ({ type: "any", required, description });
const arr = (items: "string" | "number", description: string, required = false): ParamSpec => ({
  type: "array",
  items,
  required,
  description,
});

const CONFIRM_HELP =
  "Set to true ONLY after the user has explicitly approved this exact action in the conversation. Never set it on your own.";

export const ACTIONS: ActionSpec[] = [
  // ---------- Site & diagnostics ----------
  {
    tool: "site_info", action: "site_info", tier: "read", group: "Site & diagnostics",
    description: "Site name, label, URL, WordPress / theme / WooCommerce versions. Good first call.",
    params: {},
  },
  {
    tool: "diagnostics", action: "diagnostics", tier: "read", group: "Site & diagnostics",
    description: "PHP/memory config, autoload options size, DB size and largest tables, transients/revisions counts, active caching plugins.",
    params: {},
  },
  {
    tool: "health_check_status", action: "health_check_status", tier: "read", group: "Site & diagnostics",
    description: "Result of the last hourly self-check (if health checks are enabled).",
    params: {},
  },
  {
    tool: "health_check_run", action: "health_check_run", tier: "read", group: "Site & diagnostics",
    description: "Run the health check now (DB connection, PHP fatals in debug.log, low disk space, bridge disabled).",
    params: {},
  },
  {
    tool: "cron_list", action: "cron_list", tier: "read", group: "Site & diagnostics",
    description: "All scheduled WP-Cron events, soonest first.",
    params: {},
  },
  {
    tool: "cron_run", action: "cron_run", tier: "write", group: "Site & diagnostics",
    description: "Manually fire a WP-Cron hook right now.",
    params: { hook: str("Cron hook name", true), args: arr("string", "Optional hook arguments") },
  },

  // ---------- Options ----------
  {
    tool: "option_get", action: "option_get", tier: "read", group: "Options",
    description: "Read a WordPress option by name.",
    params: { name: str("Option name", true) },
  },
  {
    tool: "option_update", action: "option_update", tier: "write", group: "Options",
    description: "Update a WordPress option. Read the current value first and tell the user what you will change.",
    params: { name: str("Option name", true), value: any("New value (string, number, boolean, array or object)", true) },
  },

  // ---------- Posts & content ----------
  {
    tool: "post_list", action: "post_list", tier: "read", group: "Posts & content",
    description: "List posts/pages/custom post types.",
    params: {
      post_type: str("e.g. post, page, product"),
      post_status: str("e.g. publish, draft, any"),
      limit: num("Max items"),
      search: str("Search term"),
    },
  },
  {
    tool: "post_get", action: "post_get", tier: "read", group: "Posts & content",
    description: "Get one post by ID.",
    params: { id: num("Post ID", true) },
  },
  {
    tool: "post_create", action: "post_create", tier: "write", group: "Posts & content",
    description: "Create a post/page. Prefer post_status=draft unless the user asked to publish.",
    params: {
      title: str("Title", true),
      content: str("HTML content"),
      excerpt: str("Excerpt"),
      post_type: str("Post type, default post"),
      post_status: str("draft, publish, ..."),
      slug: str("URL slug"),
      meta: obj("Post meta key/value pairs"),
    },
  },
  {
    tool: "post_update", action: "post_update", tier: "write", group: "Posts & content",
    description: "Update a post. Only send the fields you want to change.",
    params: {
      id: num("Post ID", true),
      title: str("Title"),
      content: str("HTML content"),
      excerpt: str("Excerpt"),
      status: str("New status"),
      slug: str("URL slug"),
      meta: obj("Post meta key/value pairs"),
    },
  },
  {
    tool: "post_delete", action: "post_delete", tier: "full", group: "Posts & content",
    description: "Delete a post. With force=true it is permanent and needs confirm=true.",
    params: {
      id: num("Post ID", true),
      force: bool("Permanent delete (skip trash)"),
      confirm: bool(CONFIRM_HELP),
    },
  },
  {
    tool: "term_list", action: "term_list", tier: "read", group: "Posts & content",
    description: "List taxonomy terms.",
    params: { taxonomy: str("Taxonomy, default category") },
  },
  {
    tool: "term_create", action: "term_create", tier: "write", group: "Posts & content",
    description: "Create a taxonomy term.",
    params: { name: str("Term name", true), taxonomy: str("Taxonomy"), slug: str("Slug") },
  },
  {
    tool: "menu_list", action: "menu_list", tier: "read", group: "Posts & content",
    description: "List navigation menus.",
    params: {},
  },
  {
    tool: "menu_item_add", action: "menu_item_add", tier: "write", group: "Posts & content",
    description: "Add an item to a navigation menu.",
    params: {
      menu: str("Menu name, slug or ID", true),
      title: str("Link title", true),
      object_id: num("Linked object ID"),
      object_type: str("e.g. page, post, category"),
      url: str("Custom URL (if not linking an object)"),
      position: num("Menu order"),
      parent_id: num("Parent menu item ID"),
    },
  },
  {
    tool: "widget_add", action: "widget_add", tier: "write", group: "Posts & content",
    description: "Add a widget to a sidebar.",
    params: {
      sidebar_id: str("Sidebar ID", true),
      id_base: str("Widget id_base, e.g. text", true),
      instance: obj("Widget settings", true),
    },
  },

  // ---------- Media ----------
  {
    tool: "media_list", action: "media_list", tier: "read", group: "Media",
    description: "List media library items.",
    params: { limit: num("Max items") },
  },
  {
    tool: "media_upload", action: "media_upload", tier: "write", group: "Media",
    description: "Upload an image (jpg, jpeg, png, gif, webp, svg) to the media library.",
    params: {
      filename: str("File name with extension", true),
      content_base64: str("Base64-encoded file content", true),
      title: str("Media title"),
    },
  },

  // ---------- Plugins & themes ----------
  {
    tool: "plugin_list", action: "plugin_list", tier: "read", group: "Plugins & themes",
    description: "List installed plugins and their active state.",
    params: {},
  },
  {
    tool: "plugin_activate", action: "plugin_activate", tier: "full", group: "Plugins & themes",
    description: "Activate a plugin. Can change site behaviour; ask the user first.",
    params: { file: str("Plugin file, e.g. akismet/akismet.php", true) },
  },
  {
    tool: "plugin_deactivate", action: "plugin_deactivate", tier: "full", group: "Plugins & themes",
    description: "Deactivate a plugin. Can break the site; ask the user first.",
    params: { file: str("Plugin file, e.g. akismet/akismet.php", true) },
  },
  {
    tool: "theme_list", action: "theme_list", tier: "read", group: "Plugins & themes",
    description: "List installed themes.",
    params: {},
  },

  // ---------- Files ----------
  {
    tool: "file_list", action: "file_list", tier: "read", group: "Files (wp-content only)",
    description: "List a directory inside wp-content.",
    params: { path: str("Path relative to wp-content") },
  },
  {
    tool: "file_read", action: "file_read", tier: "read", group: "Files (wp-content only)",
    description: "Read a file inside wp-content.",
    params: { path: str("Path relative to wp-content", true) },
  },
  {
    tool: "file_write", action: "file_write", tier: "full", group: "Files (wp-content only)",
    description: "Write a file inside wp-content (auto-backs up the old one). Can write PHP, so show the user the change first.",
    params: {
      path: str("Path relative to wp-content", true),
      content: str("Full new file content", true),
      skip_backup: bool("Skip the automatic .wpssh-bak copy (not recommended)"),
    },
  },
  {
    tool: "file_restore", action: "file_restore", tier: "full", group: "Files (wp-content only)",
    description: "Restore a file from one of its .wpssh-bak-N backups.",
    params: {
      path: str("Path relative to wp-content", true),
      backup: num("Backup number 1-3 (default 1)"),
      confirm: bool(CONFIRM_HELP, true),
    },
  },

  // ---------- Database ----------
  {
    tool: "db_query", action: "db_query", tier: "read", group: "Database",
    description: "Run a read-only SQL query (SELECT / SHOW / DESCRIBE / EXPLAIN, one statement). Use LIMIT.",
    params: { sql: str("A single read-only SQL statement", true) },
  },
  {
    tool: "db_query_write", action: "db_query", tier: "full", group: "Database",
    description: "Run a write SQL statement (INSERT/UPDATE/DELETE/...). Dangerous: show the exact SQL and get approval first. Also needs 'Allow write queries' enabled in the plugin settings.",
    params: { sql: str("SQL statement", true), confirm: bool(CONFIRM_HELP, true) },
  },
  {
    tool: "search_replace_preview", action: "search_replace", tier: "read", group: "Database",
    description: "DRY RUN of a serialization-safe search/replace across the database. Shows what would change, changes nothing.",
    params: {
      search: str("Text to find", true),
      replace: str("Replacement text", true),
      tables: arr("string", "Limit to these tables"),
    },
    fixed: { dry_run: true },
  },
  {
    tool: "search_replace", action: "search_replace", tier: "full", group: "Database",
    description: "REAL serialization-safe search/replace across the database. Run search_replace_preview first and get approval.",
    params: {
      search: str("Text to find", true),
      replace: str("Replacement text", true),
      tables: arr("string", "Limit to these tables"),
    },
    fixed: { dry_run: false },
  },
  {
    tool: "cache_clear", action: "cache_clear", tier: "write", group: "Database",
    description: "Clear Elementor CSS/render cache, theme compiled CSS, object cache and popular page-cache plugins.",
    params: {
      post_id: num("Clear cache for one post only"),
      all_elementor: bool("Clear all Elementor caches"),
      transients: bool("Also delete transients"),
    },
  },

  // ---------- WooCommerce ----------
  {
    tool: "order_list", action: "order_list", tier: "read", group: "WooCommerce",
    description: "List WooCommerce orders (WooCommerce must be active).",
    params: { limit: num("Max items"), status: str("e.g. processing, completed"), search: str("Search term") },
  },
  {
    tool: "order_get", action: "order_get", tier: "read", group: "WooCommerce",
    description: "Full order detail including line items and addresses.",
    params: { id: num("Order ID", true) },
  },
  {
    tool: "order_update_status", action: "order_update_status", tier: "write", group: "WooCommerce",
    description: "Change an order's status. May trigger customer emails.",
    params: { id: num("Order ID", true), status: str("New status", true), note: str("Order note") },
  },
  {
    tool: "product_attribute_set", action: "product_attribute_set", tier: "write", group: "WooCommerce",
    description: "Set a product attribute and its terms in one call.",
    params: {
      product_id: num("Product ID", true),
      taxonomy: str("Attribute taxonomy, e.g. pa_color", true),
      term_ids: arr("number", "Term IDs", true),
      is_variation: bool("Use for variations"),
    },
  },

  // ---------- Elementor ----------
  {
    tool: "elementor_data_get", action: "elementor_data_get", tier: "read", group: "Elementor",
    description: "Raw _elementor_data JSON of a page. Can be very large.",
    params: { post_id: num("Post ID", true) },
  },
  {
    tool: "elementor_data_set", action: "elementor_data_set", tier: "write", group: "Elementor",
    description: "Replace a page's Elementor data (validated, then CSS cache is cleared). Export or read the current data first.",
    params: { post_id: num("Post ID", true), data: any("Elementor data (JSON string or array)", true) },
  },
  {
    tool: "template_export", action: "template_export", tier: "read", group: "Elementor",
    description: "Export a page's Elementor data + settings so it can be copied to another site with template_import.",
    params: { post_id: num("Post ID", true) },
  },
  {
    tool: "template_import", action: "template_import", tier: "write", group: "Elementor",
    description: "Create or update a page from exported Elementor data (typically produced by template_export on another site).",
    params: {
      title: str("Page title", true),
      elementor_data: any("Elementor data from template_export", true),
      post_id: num("Update this post instead of creating a new one"),
      post_type: str("Post type"),
      post_status: str("Post status, prefer draft"),
      elementor_page_settings: obj("Page settings from template_export"),
      page_template: str("Page template"),
    },
  },
];

export const TIER_RANK: Record<Tier, number> = { read: 0, write: 1, full: 2 };
