import { execSync, spawnSync } from "child_process";
import type { BetterMcpConfig } from "../config.js";

/**
 * Run a predefined shell command from config.
 */
export function runCommand(
  name: string,
  config: BetterMcpConfig,
  workdir?: string
): { stdout: string; stderr: string; exitCode: number; duration: number } {
  const shellConfig = config.tools.shell;
  if (!shellConfig?.commands) {
    throw new Error("No shell commands configured. Set shell.commands in better-mcp.json");
  }

  const command = shellConfig.commands[name];
  if (!command) {
    const available = Object.keys(shellConfig.commands).join(", ");
    throw new Error(
      `Unknown command "${name}". Available commands: ${available}`
    );
  }

  const cwd = workdir || config.root;

  const start = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf-8",
    timeout: 300_000, // 5 min default
    maxBuffer: 10 * 1024 * 1024, // 10MB
    env: {
      ...process.env,
      PROJECT_ROOT: config.root,
    },
  });
  const duration = Date.now() - start;

  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? -1,
    duration,
  };
}

/**
 * Run a raw shell command (if allowed by config).
 */
export function runRaw(
  command: string,
  config: BetterMcpConfig,
  timeout = 120
): { stdout: string; stderr: string; exitCode: number; duration: number } {
  const shellConfig = config.tools.shell;
  if (!shellConfig?.allowRaw) {
    throw new Error(
      "Raw shell commands not allowed. Set shell.allowRaw: true in better-mcp.json to enable"
    );
  }

  const start = Date.now();
  const result = spawnSync(command, {
    cwd: config.root,
    shell: true,
    encoding: "utf-8",
    timeout: timeout * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const duration = Date.now() - start;

  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? -1,
    duration,
  };
}
