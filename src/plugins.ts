import { existsSync, readdirSync, statSync } from "fs";
import { resolve, isAbsolute } from "path";
import type { BetterMcpConfig } from "./config.js";

// ─── Types ─────────────────────────────────────────────────────────────

export interface PluginTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  handler: (
    args: Record<string, unknown>,
    context: { config: BetterMcpConfig; project: string },
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

export interface PluginDefinition {
  name: string;
  version: string;
  description?: string;
  tools: PluginTool[];
}

export interface LoadedPlugin {
  name: string;
  version: string;
  description: string;
  tools: PluginTool[];
  filePath: string;
}

export interface PluginsConfig {
  dir?: string;
  enabled?: boolean;
  allowlist?: string[];
  timeout?: number;
}

// ─── Validation ────────────────────────────────────────────────────────

/**
 * Validate that an object is a properly structured plugin definition.
 * Returns an array of validation error messages. Empty array = valid.
 */
export function validatePlugin(obj: unknown): string[] {
  const errors: string[] = [];

  if (!obj || typeof obj !== "object") {
    return ["Plugin must be a non-null object"];
  }

  const plugin = obj as Record<string, unknown>;

  // name: required, non-empty string
  if (typeof plugin.name !== "string" || plugin.name.length === 0) {
    errors.push("Plugin 'name' must be a non-empty string");
  }

  // version: required, non-empty string
  if (typeof plugin.version !== "string" || plugin.version.length === 0) {
    errors.push("Plugin 'version' must be a non-empty string");
  }

  // description: optional string
  if (plugin.description !== undefined && typeof plugin.description !== "string") {
    errors.push("Plugin 'description' must be a string");
  }

  // tools: required, must be an array
  if (!Array.isArray(plugin.tools)) {
    errors.push("Plugin 'tools' must be an array");
    return errors; // can't validate further
  }

  if (plugin.tools.length === 0) {
    errors.push("Plugin 'tools' must have at least one tool");
  }

  for (let i = 0; i < plugin.tools.length; i++) {
    const tool = plugin.tools[i];
    const prefix = `tools[${i}]`;

    if (!tool || typeof tool !== "object") {
      errors.push(`${prefix}: must be a non-null object`);
      continue;
    }

    const t = tool as Record<string, unknown>;

    if (typeof t.name !== "string" || t.name.length === 0) {
      errors.push(`${prefix}.name: must be a non-empty string`);
    }

    if (typeof t.description !== "string") {
      errors.push(`${prefix}.description: must be a string`);
    }

    if (!t.inputSchema || typeof t.inputSchema !== "object") {
      errors.push(`${prefix}.inputSchema: must be an object with type: 'object'`);
    } else {
      const schema = t.inputSchema as Record<string, unknown>;
      if (schema.type !== "object") {
        errors.push(`${prefix}.inputSchema.type: must be 'object'`);
      }
    }

    if (typeof t.handler !== "function") {
      errors.push(`${prefix}.handler: must be a function`);
    }
  }

  return errors;
}

// ─── Discovery ─────────────────────────────────────────────────────────

const PLUGIN_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"];

/**
 * Discover plugin files in a directory.
 * Returns an array of absolute file paths matching plugin file extensions.
 */
export function discoverPluginFiles(pluginsDir: string): string[] {
  if (!existsSync(pluginsDir)) {
    return [];
  }

  const entries = readdirSync(pluginsDir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(pluginsDir, entry);

    // Skip directories
    if (statSync(fullPath).isDirectory()) {
      continue;
    }

    const ext = entry.substring(entry.lastIndexOf("."));
    if (PLUGIN_EXTENSIONS.includes(ext)) {
      files.push(fullPath);
    }
  }

  // Sort for deterministic loading order
  files.sort();
  return files;
}

/**
 * Load a single plugin from a file path.
 * Handles both .ts and .js files via dynamic import.
 * Returns null if loading or validation fails.
 */
export async function loadPluginFile(filePath: string): Promise<LoadedPlugin | null> {
  try {
    // Dynamic import — works for .ts with ts-node/tsx, and .js in both dev and prod
    const mod = await import(filePath);

    // Check for named export 'plugin' (preferred) or default export
    const pluginObj: unknown = mod.plugin ?? mod.default ?? null;

    if (!pluginObj) {
      console.error(`[plugins] Plugin file "${filePath}" has no 'plugin' or default export`);
      return null;
    }

    const errors = validatePlugin(pluginObj);
    if (errors.length > 0) {
      console.error(`[plugins] Plugin "${filePath}" validation failed:`);
      for (const err of errors) {
        console.error(`  - ${err}`);
      }
      return null;
    }

    const p = pluginObj as PluginDefinition;

    return {
      name: p.name,
      version: p.version,
      description: p.description || "",
      tools: p.tools,
      filePath,
    };
  } catch (err) {
    console.error(`[plugins] Failed to load plugin from "${filePath}":`, (err as Error).message);
    return null;
  }
}

/**
 * Discover and load all plugins from the configured plugins directory.
 * Respects the allowlist (if non-empty, only load matching plugin names).
 * Individual plugin failures are logged and skipped.
 */
export async function discoverPlugins(
  config: BetterMcpConfig,
  rootDir: string,
): Promise<LoadedPlugin[]> {
  const pluginsConfig: PluginsConfig = config.tools?.plugins ?? {};

  if (pluginsConfig.enabled === false) {
    return [];
  }

  const dir = pluginsConfig.dir || defaultPluginsDir(rootDir);
  const allowlist = pluginsConfig.allowlist ?? [];
  const hasAllowlist = Array.isArray(allowlist) && allowlist.length > 0;

  const files = discoverPluginFiles(dir);
  const loaded: LoadedPlugin[] = [];

  for (const filePath of files) {
    const plugin = await loadPluginFile(filePath);

    if (!plugin) {
      continue; // Already logged by loadPluginFile
    }

    // Check allowlist
    if (hasAllowlist && !allowlist.includes(plugin.name)) {
      console.error(
        `[plugins] Plugin "${plugin.name}" from "${filePath}" not in allowlist, skipping`,
      );
      continue;
    }

    loaded.push(plugin);
  }

  return loaded;
}

/**
 * Resolve the default plugins directory path.
 * If the path is relative, it's resolved relative to the project root.
 */
export function defaultPluginsDir(rootDir: string): string {
  return resolve(rootDir, "plugins");
}

/**
 * Get all tools from all loaded plugins, with prefixed names.
 * Returns tools with names like `plugin_<plugin_name>_<tool_name>`.
 */
export function getPluginTools(
  plugins: LoadedPlugin[],
): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: PluginTool["handler"];
}> {
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: PluginTool["handler"];
  }> = [];

  for (const plugin of plugins) {
    for (const tool of plugin.tools) {
      tools.push({
        name: `plugin_${plugin.name}_${tool.name}`,
        description: `[${plugin.name} v${plugin.version}] ${tool.description}`,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        handler: tool.handler,
      });
    }
  }

  return tools;
}

/**
 * Get plugin summary info for display.
 */
export function getPluginSummary(plugins: LoadedPlugin[]): Array<{
  name: string;
  version: string;
  description: string;
  toolCount: number;
}> {
  return plugins.map((p) => ({
    name: p.name,
    version: p.version,
    description: p.description,
    toolCount: p.tools.length,
  }));
}
