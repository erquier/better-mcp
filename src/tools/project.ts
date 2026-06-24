import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, isAbsolute } from "path";
import type { BetterMcpConfig } from "../config.js";

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
