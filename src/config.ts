import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, isAbsolute, basename } from "path";
import type { AuthConfig } from "./auth.js";

export interface PluginsConfig {
  dir?: string;
  enabled?: boolean;
  allowlist?: string[];
  timeout?: number;
}

export interface ProjectConfig {
  name: string;
  root: string;
  description?: string;
  stack?: string[];
  tools: {
    fs?: {
      allowedPaths: string[];
      maxFileSize?: number;
    };
    db?: {
      url: string;
      readOnly?: boolean;
      schemas?: string[];
      maxRows?: number;
    };
    shell?: {
      commands: Record<string, string>;
      allowRaw?: boolean;
    };
    git?: {
      enabled?: boolean;
      maxCommits?: number;
    };
  };
  resources?: Record<string, string>;
}

export interface BetterMcpConfig {
  // Backward-compat single project fields
  project?: string;
  root?: string;
  name?: string;
  description?: string;
  stack?: string[];
  transport?: "stdio" | "http";
  port?: number;
  auth?: AuthConfig;
  tools?: {
    fs?: {
      allowedPaths: string[];
      maxFileSize?: number;
    };
    db?: {
      url: string;
      readOnly?: boolean;
      schemas?: string[];
      maxRows?: number;
    };
    shell?: {
      commands: Record<string, string>;
      allowRaw?: boolean;
    };
    git?: {
      enabled?: boolean;
      maxCommits?: number;
    };
    plugins?: PluginsConfig;
  };
  resources?: Record<string, string>;

  // Multi-project mode
  projects?: ProjectConfig[];
}

// ─── Active project tracking (mutable module-level state) ──────────────
const _activeProject: { name: string | null } = { name: null };

export function setActiveProject(name: string | null): void {
  _activeProject.name = name;
}

export function getActiveProjectName(): string | null {
  return _activeProject.name;
}

// ─── Project resolution helpers ────────────────────────────────────────

/**
 * Convert a ProjectConfig to a legacy-style BetterMcpConfig for use
 * with tool functions that expect the old format.
 */
export function projectToConfig(project: ProjectConfig): BetterMcpConfig {
  return {
    project: project.name,
    root: project.root,
    name: project.name,
    description: project.description,
    stack: project.stack,
    tools: project.tools,
    resources: project.resources,
  };
}

/**
 * Get a project by name from the config.
 * Works with both multi-project (projects[]) and single-project (legacy) configs.
 */
export function getProject(
  name: string,
  config: BetterMcpConfig,
): ProjectConfig {
  if (config.projects) {
    const project = config.projects.find((p) => p.name === name);
    if (!project) {
      throw new Error(
        `Project "${name}" not found. Available: ${config.projects.map((p) => p.name).join(", ")}`,
      );
    }
    return project;
  }

  // Legacy mode — use single project fields
  if (!config.project || !config.root) {
    throw new Error("No projects configured");
  }
  return {
    name: config.name || config.project,
    root: config.root,
    description: config.description,
    stack: config.stack,
    tools: config.tools || { fs: { allowedPaths: [config.root] } },
    resources: config.resources,
  };
}

/**
 * Get the default (or active) project from the config.
 * - If an active project is set via workspace_set_project, returns that.
 * - Otherwise returns the first project (multi-project) or the single project (legacy).
 */
export function getDefaultProject(config: BetterMcpConfig): ProjectConfig {
  if (config.projects && config.projects.length > 0) {
    // Active project takes priority
    const activeName = _activeProject.name;
    if (activeName) {
      const active = config.projects.find((p) => p.name === activeName);
      if (active) return active;
    }
    return config.projects[0];
  }

  // Legacy mode
  return {
    name: config.name || config.project || "default",
    root: config.root || "",
    description: config.description,
    stack: config.stack,
    tools: config.tools || { fs: { allowedPaths: [config.root || ""] } },
    resources: config.resources,
  };
}

/**
 * Get all configured projects.
 */
export function getAllProjects(config: BetterMcpConfig): ProjectConfig[] {
  if (config.projects && config.projects.length > 0) {
    return config.projects;
  }

  // Legacy mode — wrap single project into an array
  if (config.project && config.root) {
    return [
      {
        name: config.name || config.project,
        root: config.root,
        description: config.description,
        stack: config.stack,
        tools: config.tools || { fs: { allowedPaths: [config.root] } },
        resources: config.resources,
      },
    ];
  }

  return [];
}

export function resolveEnv(value: string): string {
  if (value.length > 5000) {
    return value;
  }
  return value.replace(/\$\{(\w+)\}/g, (_, key) => {
    const envVal = process.env[key];
    // Limit env var value length to prevent expansion bombs
    if (envVal && envVal.length > 10000) {
      return "";
    }
    return envVal ?? "";
  });
}

// ─── Zero-config auto-detection ─────────────────────────────────────────
// "Drop into any project": if there's no better-mcp.json, build a sensible
// config by scanning the working directory — root = cwd, the repo as the fs
// sandbox, package.json scripts as shell commands, DATABASE_URL (if postgres)
// as the DB, and common docs as resources. No setup, no Docker image required.

const STACK_MARKERS: Array<[string, string]> = [
  ["package.json", "node"],
  ["tsconfig.json", "typescript"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
  ["prisma/schema.prisma", "prisma"],
  ["docker-compose.yml", "docker"],
  ["docker-compose.yaml", "docker"],
  ["next.config.js", "nextjs"],
  ["next.config.ts", "nextjs"],
  ["vite.config.ts", "vite"],
  ["vite.config.js", "vite"],
];

function detectPackageManager(root: string): string {
  if (existsSync(resolve(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(root, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(root, "bun.lockb"))) return "bun";
  return "npm";
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectDbUrl(root: string): string | undefined {
  // Prefer the live env, then parse a .env file. Only return postgres URLs since
  // the db tool drives psql; other engines are skipped (db tool stays disabled).
  const fromEnv = process.env.DATABASE_URL;
  const isPg = (u: string) => /^(postgres|postgresql|psql):\/\//.test(u.trim());
  if (fromEnv && isPg(fromEnv)) return fromEnv;
  const envFile = resolve(root, ".env");
  if (existsSync(envFile)) {
    try {
      for (const line of readFileSync(envFile, "utf-8").split("\n")) {
        const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/);
        if (m) {
          const val = m[1].trim().replace(/^["']|["']$/g, "");
          if (isPg(val)) return val;
        }
      }
    } catch {
      /* ignore unreadable .env */
    }
  }
  return undefined;
}

function detectCommands(root: string): Record<string, string> {
  const commands: Record<string, string> = {};
  const pm = detectPackageManager(root);
  const pkg = readJsonSafe(resolve(root, "package.json"));
  const scripts = (pkg?.scripts as Record<string, string> | undefined) ?? {};
  // Expose the common, safe-to-run scripts the project already defines.
  const interesting = ["build", "test", "lint", "typecheck", "type-check", "tsc", "dev", "start", "test:e2e"];
  for (const name of interesting) {
    if (scripts[name]) commands[name] = `${pm} run ${name}`;
  }
  // Useful operational snapshots when the markers are present.
  if (existsSync(resolve(root, "prisma/schema.prisma"))) {
    commands["migrate-status"] = "npx prisma migrate status";
  }
  if (existsSync(resolve(root, "docker-compose.yml")) || existsSync(resolve(root, "docker-compose.yaml"))) {
    commands["ps"] = "docker compose ps";
    commands["logs"] = "docker compose logs --no-color --tail=200";
  }
  return commands;
}

function detectResources(root: string): Record<string, string> {
  const resources: Record<string, string> = {};
  const add = (name: string, rel: string) => {
    if (existsSync(resolve(root, rel))) resources[name] = rel;
  };
  add("readme", "README.md");
  add("changelog", "CHANGELOG.md");
  add("schema", "prisma/schema.prisma");
  // Pick up a handoff/onboarding doc if present (common agent entry point).
  try {
    for (const f of readdirSync(root)) {
      if (/handoff|onboarding/i.test(f) && /\.md$/i.test(f)) {
        resources["handoff"] = f;
        break;
      }
    }
  } catch {
    /* ignore */
  }
  return resources;
}

/** Build a sensible config from a project directory, with no better-mcp.json. */
export function buildAutoConfig(root: string = process.cwd()): BetterMcpConfig {
  const abs = resolve(root);
  const pkg = readJsonSafe(resolve(abs, "package.json"));
  const name = (typeof pkg?.name === "string" && pkg.name) || basename(abs) || "project";
  const stack = STACK_MARKERS.filter(([file]) => existsSync(resolve(abs, file))).map(([, key]) => key);
  const uniqueStack = Array.from(new Set(stack));

  const tools: NonNullable<BetterMcpConfig["tools"]> = {
    fs: { allowedPaths: [abs] },
    git: { enabled: existsSync(resolve(abs, ".git")) },
  };
  const commands = detectCommands(abs);
  if (Object.keys(commands).length > 0) tools.shell = { commands };
  const dbUrl = detectDbUrl(abs);
  if (dbUrl) tools.db = { url: dbUrl, readOnly: true };

  const resources = detectResources(abs);

  return {
    project: name,
    name,
    root: abs,
    description: typeof pkg?.description === "string" ? pkg.description : undefined,
    stack: uniqueStack,
    tools,
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
  };
}

export function loadConfig(configPath?: string): BetterMcpConfig {
  const paths = configPath
    ? [configPath]
    : ["better-mcp.json", "./better-mcp.json"];

  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
    if (existsSync(abs)) {
      const raw = readFileSync(abs, "utf-8");
      const parsed: BetterMcpConfig = JSON.parse(raw);

      // Resolve env vars in projects array
      if (parsed.projects) {
        for (const project of parsed.projects) {
          if (project.tools.db?.url) {
            project.tools.db.url = resolveEnv(project.tools.db.url);
          }
        }
      }

      // Resolve env vars in legacy single-project mode
      if (parsed.tools?.db?.url) {
        parsed.tools.db.url = resolveEnv(parsed.tools.db.url);
      }

      validateConfig(parsed);
      return parsed;
    }
  }

  // An explicit --config path that doesn't exist is an error (the user meant it).
  if (configPath) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  // Zero-config: no better-mcp.json → auto-detect from the working directory.
  const auto = buildAutoConfig(process.cwd());
  validateConfig(auto);
  console.error(
    `better-mcp: no better-mcp.json found — using auto-detected config for "${auto.name}" ` +
      `(root: ${auto.root}). Run \`better-mcp init\` to customize.`,
  );
  return auto;
}

function validateProjectTools(project: ProjectConfig, prefix: string): void {
  if (project.tools.fs) {
    if (!project.tools.fs.allowedPaths?.length) {
      throw new Error(`${prefix}: fs.allowedPaths must be a non-empty array`);
    }
    for (const p of project.tools.fs.allowedPaths) {
      if (!isAbsolute(p)) {
        throw new Error(`${prefix}: fs.allowedPaths must be absolute: ${p}`);
      }
    }
  }

  if (project.tools.shell) {
    if (
      !project.tools.shell.commands ||
      typeof project.tools.shell.commands !== "object"
    ) {
      throw new Error(
        `${prefix}: shell.commands must be an object of command name -> shell command`,
      );
    }
    for (const [key, val] of Object.entries(project.tools.shell.commands)) {
      if (typeof val !== "string") {
        throw new Error(`${prefix}: shell.commands.${key} must be a string`);
      }
    }
  }

  if (project.tools.db && !project.tools.db.url) {
    throw new Error(`${prefix}: db.url is required when db tools are enabled`);
  }
}

function validateConfig(config: BetterMcpConfig): void {
  if (config.projects) {
    if (!Array.isArray(config.projects) || config.projects.length === 0) {
      throw new Error("Config 'projects' must be a non-empty array");
    }
    for (let i = 0; i < config.projects.length; i++) {
      const p = config.projects[i];
      if (!p.name) throw new Error(`projects[${i}]: missing "name"`);
      if (!p.root) throw new Error(`projects[${i}]: missing "root"`);
      if (!p.tools) throw new Error(`projects[${i}]: missing "tools"`);
      validateProjectTools(p, `projects[${i}] (${p.name})`);
    }
  } else {
    // Backward compat: single project mode
    if (!config.project) throw new Error("Config missing: project");
    if (!config.root) throw new Error("Config missing: root");
    if (!config.tools) throw new Error("Config missing: tools");

    validateProjectTools(
      {
        name: config.project,
        root: config.root,
        tools: config.tools,
      } as ProjectConfig,
      "config",
    );
  }
}
