import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, isAbsolute } from "path";
import type { BetterMcpConfig } from "../config.js";
import type { ToolDefinition, ToolContext } from "../tool-registry.js";

/**
 * Get comprehensive project information.
 */
export function info(
  config: BetterMcpConfig,
  pluginInfo?: Array<{ name: string; version: string; description: string; toolCount: number }>,
): {
  project: string;
  name: string;
  description: string;
  root: string;
  stack: string[];
  directoryCount: number;
  fileCount: number;
  totalSizeBytes: number;
  hasConfig: Record<string, boolean>;
  enabledTools: string[];
  availableCommands: string[];
  resources: Record<string, string>;
  plugins: Array<{ name: string; version: string; description: string; toolCount: number }>;
} {
  const root: string = config.root ?? process.cwd();
  const tools = config.tools ?? ({} as NonNullable<BetterMcpConfig["tools"]>);

  // Count files and directories
  let fileCount = 0;
  let directoryCount = 0;
  let totalSizeBytes = 0;

  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      try {
        const fullPath = resolve(root, entry.name);
        if (entry.isDirectory()) {
          directoryCount++;
          countRecursive(fullPath, (files, dirs, size) => {
            fileCount += files;
            directoryCount += dirs;
            totalSizeBytes += size;
          });
        } else if (entry.isFile()) {
          fileCount++;
          totalSizeBytes += statSync(fullPath).size;
        }
      } catch {
        // Permission issues, skip
      }
    }
  } catch {
    // root not accessible
  }

  // Check for common config files
  const hasConfig: Record<string, boolean> = {};
  const configFiles = [
    ["package.json", "node"],
    ["tsconfig.json", "typescript"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
    ["Dockerfile", "docker"],
    ["docker-compose.yml", "docker"],
    ["docker-compose.yaml", "docker"],
    [".github", "github-actions"],
    ["prisma", "prisma"],
    [".env", "env"],
    ["Makefile", "make"],
    ["next.config.js", "nextjs"],
    ["next.config.ts", "nextjs"],
    ["vite.config.ts", "vite"],
    ["vite.config.js", "vite"],
  ];

  for (const [fileName, key] of configFiles) {
    hasConfig[key] = hasConfig[key] || existsSync(resolve(root, fileName));
  }

  const enabledTools: string[] = [];
  if (tools.fs) enabledTools.push("filesystem");
  if (tools.db) enabledTools.push("database");
  if (tools.shell) enabledTools.push("shell");
  if (tools.git?.enabled !== false) enabledTools.push("git");

  const availableCommands = tools.shell?.commands
    ? Object.keys(tools.shell.commands)
    : [];

  const resources: Record<string, string> = {};
  if (config.resources) {
    for (const [name, path] of Object.entries(config.resources)) {
      const fullPath = isAbsolute(path) ? path : resolve(root, path);
      resources[name] = fullPath;
    }
  }

  return {
    project: config.project || "default",
    name: config.name || config.project || "default",
    description: config.description || "",
    root,
    stack: config.stack || [],
    directoryCount,
    fileCount,
    totalSizeBytes,
    hasConfig,
    enabledTools,
    availableCommands,
    resources,
    plugins: pluginInfo ?? [],
  };
}

function countRecursive(
  dirPath: string,
  callback: (files: number, dirs: number, size: number) => void
): void {
  let files = 0;
  let dirs = 0;
  let size = 0;

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      try {
        const fullPath = resolve(dirPath, entry.name);
        if (entry.isDirectory()) {
          dirs++;
          countRecursive(fullPath, (f, d, s) => {
            files += f;
            dirs += d;
            size += s;
          });
        } else if (entry.isFile()) {
          files++;
          size += statSync(fullPath).size;
        }
      } catch {
        // Skip inaccessible
      }
    }
  } catch {
    // Skip
  }

  callback(files, dirs, size);
}

/**
 * Read a project resource (handoff, plan, schema, etc.).
 */
export function readResource(
  name: string,
  config: BetterMcpConfig
): { name: string; content: string; path: string } {
  const root: string = config.root ?? process.cwd();

  if (!config.resources || !config.resources[name]) {
    const available = config.resources ? Object.keys(config.resources).join(", ") : "(none)";
    throw new Error(
      `Resource "${name}" not found. Available resources: ${available}`
    );
  }

  const relPath = config.resources[name];
  const fullPath = isAbsolute(relPath) ? relPath : resolve(root, relPath);

  if (!existsSync(fullPath)) {
    throw new Error(`Resource file not found: "${name}"`);
  }

  const content = readFileSync(fullPath, "utf-8");
  return { name, content, path: fullPath };
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

/**
 * Get project-related tool definitions for the MCP server.
 */
export function getToolDefinitions(config: BetterMcpConfig, state: { activeProject: string | null }): ToolDefinition[] {
  const projects: Array<{ name: string; root: string; tools: any; resources?: Record<string, string> }> = [];
  if (config.projects && config.projects.length > 0) {
    projects.push(...config.projects);
  } else if (config.project && config.root) {
    projects.push({
      name: config.name || config.project,
      root: config.root,
      tools: config.tools || { fs: { allowedPaths: [config.root] } },
      resources: config.resources,
    });
  }
  const isMultiProject = projects.length > 1;
  const projectNames = projects.map((p) => p.name).join(", ");

  return [
    {
      name: "project_info",
      description: "Get comprehensive info about a project: stack, structure, file counts, config detection, enabled tools.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const result = info(ctx.config, ctx.loadedPlugins.length > 0
          ? ctx.loadedPlugins.map((p) => ({
              name: p.name,
              version: p.version,
              description: p.description,
              toolCount: p.tools.length,
            }))
          : undefined);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    },
    {
      name: "read_resource",
      description: "Read a project resource file (handoff, plan, schema, docs).",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: `Resource name. Available: ${
              projects
                .flatMap((p) => (p.resources ? Object.keys(p.resources) : []))
                .join(", ") || "(none)"
            }`,
          },
        },
        required: ["name"],
      },
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const resourceName = args.name;
        if (typeof resourceName !== "string" || resourceName.length === 0) {
          throw new Error("read_resource requires a non-empty string 'name'");
        }
        const result = readResource(resourceName, ctx.config);
        return { content: [{ type: "text", text: result.content }] };
      },
    },
    // ── Workspace tools ──
    {
      name: "workspace_list_projects",
      description: "List all configured projects with their name, root, stack, and enabled tools.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              projects.map((p) => ({
                name: p.name,
                root: p.root,
                stack: config.stack || [],
                description: config.description || "",
                enabledTools: getEnabledToolsList(p.tools),
                availableCommands: p.tools?.shell?.commands
                  ? Object.keys(p.tools.shell.commands)
                  : [],
                resources: p.resources || {},
              })),
            ),
          }],
        };
      },
    },
    {
      name: "workspace_set_project",
      description: "Set the active project for subsequent tool calls that don't specify a project explicitly.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: `Project name to set as active. Available: ${projectNames}`,
          },
        },
        required: ["name"],
      },
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const projectName = args.name;
        if (typeof projectName !== "string" || projectName.length === 0) {
          throw new Error("workspace_set_project requires a non-empty string 'name'");
        }
        // Verify the project exists (will throw if not found)
        if (config.projects) {
          const found = config.projects.find((p) => p.name === projectName);
          if (!found) {
            throw new Error(
              `Project "${projectName}" not found. Available: ${config.projects.map((p) => p.name).join(", ")}`,
            );
          }
        }
        // Update state
        ctx.state.activeProject = projectName;
        return {
          content: [{ type: "text", text: JSON.stringify({ activeProject: projectName }) }],
        };
      },
    },
  ];
}

function getEnabledToolsList(tools: any): string[] {
  const result: string[] = [];
  if (tools?.fs) result.push("filesystem");
  if (tools?.db) result.push("database");
  if (tools?.shell) result.push("shell");
  if (tools?.git?.enabled !== false) result.push("git");
  return result;
}
