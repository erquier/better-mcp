import { readFileSync, existsSync } from "fs";
import { resolve, isAbsolute } from "path";
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

  throw new Error("Config file (better-mcp.json) not found");
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
