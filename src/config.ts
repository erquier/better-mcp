import { readFileSync, existsSync } from "fs";
import { resolve, isAbsolute } from "path";

export interface BetterMcpConfig {
  project: string;
  root: string;
  name?: string;
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

      // Resolve env vars
      if (parsed.tools.db?.url) {
        parsed.tools.db.url = resolveEnv(parsed.tools.db.url);
      }

      validateConfig(parsed);
      return parsed;
    }
  }

  throw new Error("Config file (better-mcp.json) not found");
}

function validateConfig(config: BetterMcpConfig): void {
  if (!config.project) throw new Error("Config missing: project");
  if (!config.root) throw new Error("Config missing: root");

  if (config.tools.fs) {
    if (!config.tools.fs.allowedPaths?.length) {
      throw new Error("fs.allowedPaths must be a non-empty array");
    }
    for (const p of config.tools.fs.allowedPaths) {
      if (!isAbsolute(p)) {
        throw new Error(`fs.allowedPaths must be absolute: ${p}`);
      }
    }
  }

  if (config.tools.shell) {
    if (!config.tools.shell.commands || typeof config.tools.shell.commands !== "object") {
      throw new Error("shell.commands must be an object of command name -> shell command");
    }
    for (const [key, val] of Object.entries(config.tools.shell.commands)) {
      if (typeof val !== "string") {
        throw new Error(`shell.commands.${key} must be a string`);
      }
    }
  }

  if (config.tools.db && !config.tools.db.url) {
    throw new Error("db.url is required when db tools are enabled");
  }
}
