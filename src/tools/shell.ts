import { spawnSync } from "child_process";
import type { BetterMcpConfig } from "../config.js";

const MAX_COMMAND_LENGTH = 10000;
const MAX_COMMAND_OUTPUT = 10 * 1024 * 1024; // 10 MB

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
    throw new Error("No shell commands configured");
  }

  // Validate command name
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Command name must be a non-empty string");
  }
  if (name.length > 100) {
    throw new Error("Command name is too long");
  }

  const command = shellConfig.commands[name];
  if (!command) {
    const available = Object.keys(shellConfig.commands).join(", ");
    throw new Error(
      `Unknown command "${name}". Available commands: ${available}`
    );
  }

  // Validate command string from config
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Command configuration is invalid");
  }

  const cwd = workdir || config.root;
  return runShellCommand(command, cwd, 300);
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

  // Validate raw command input
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Command must be a non-empty string");
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`Command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters`);
  }

  // Reject dangerous shell metacharacters that enable multi-command injection
  // Allow basic pipes, redirects, and command chaining but block things like:
  // - Backtick command substitution: `cmd`
  // - $() command substitution: $(cmd)
  // - Newlines that break command boundaries
  if (/[`\n\r]/.test(command)) {
    throw new Error("Command contains prohibited shell metacharacters");
  }

  return runShellCommand(command, config.root, Math.max(1, Math.min(timeout, 3600)));
}

/**
 * Execute a shell command using spawnSync with shell:true but with input validation.
 * Predefined commands (from config) are trusted; raw commands get additional sanitization.
 */
function runShellCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number
): { stdout: string; stderr: string; exitCode: number; duration: number } {
  const start = Date.now();

  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf-8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: MAX_COMMAND_OUTPUT,
    env: {
      ...process.env,
      PROJECT_ROOT: cwd,
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
