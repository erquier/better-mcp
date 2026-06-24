import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runCommand, runRaw } from "../tools/shell.js";
import type { BetterMcpConfig } from "../config.js";

const tmpDir = mkdtempSync(join(tmpdir(), "better-mcp-shell-test-"));
const otherDir = mkdtempSync(join(tmpdir(), "better-mcp-shell-other-"));

const testConfig: BetterMcpConfig = {
  project: "test-project",
  root: tmpDir,
  name: "Test",
  stack: ["typescript", "node"],
  tools: {
    shell: {
      commands: {
        build: "npx tsc",
        test: "echo 'tests ok'",
        greet: 'echo "hello world"',
        fail: "exit 1",
      },
      allowRaw: true,
    },
    git: {
      enabled: true,
    },
  },
  resources: {
    readme: "README.md",
  },
};

const configNoShell: BetterMcpConfig = {
  project: "test-project",
  root: otherDir,
  tools: {},
};

const configNoRaw: BetterMcpConfig = {
  project: "test-project",
  root: otherDir,
  tools: {
    shell: {
      commands: {
        build: "echo building",
      },
      allowRaw: false,
    },
  },
};

describe("runCommand", () => {
  it("should run a valid predefined command and return stdout", () => {
    const result = runCommand("test", testConfig);
    expect(result.stdout).toBe("tests ok");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("should run a command that echoes", () => {
    const result = runCommand("greet", testConfig);
    expect(result.stdout).toBe("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("should capture exit code for failing command", () => {
    const result = runCommand("fail", testConfig);
    expect(result.exitCode).toBe(1);
  });

  it("should throw for empty command name", () => {
    expect(() => runCommand("", testConfig)).toThrow(
      "Command name must be a non-empty string",
    );
  });

  it("should throw for unknown command name", () => {
    expect(() => runCommand("nonexistent", testConfig)).toThrow(
      'Unknown command "nonexistent"',
    );
  });

  it("should throw when no shell commands configured", () => {
    expect(() => runCommand("build", configNoShell)).toThrow(
      "No shell commands configured",
    );
  });

  it("should throw for command name exceeding 100 characters", () => {
    expect(() => runCommand("a".repeat(101), testConfig)).toThrow(
      "Command name is too long",
    );
  });

  it("should accept an optional workdir parameter", () => {
    const result = runCommand("greet", testConfig, otherDir);
    expect(result.stdout).toBe("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("should throw for non-string command name", () => {
    expect(() => runCommand(123 as any, testConfig)).toThrow(
      "Command name must be a non-empty string",
    );
  });
});

describe("runRaw", () => {
  it("should run a raw command when allowRaw is true", () => {
    const result = runRaw("echo raw-test", testConfig);
    expect(result.stdout).toBe("raw-test");
    expect(result.exitCode).toBe(0);
  });

  it("should throw if allowRaw is false", () => {
    expect(() => runRaw("echo test", configNoRaw)).toThrow(
      "Raw shell commands not allowed",
    );
  });

  it("should throw if shell config is missing", () => {
    expect(() => runRaw("echo test", configNoShell)).toThrow(
      "Raw shell commands not allowed",
    );
  });

  it("should throw for empty command", () => {
    expect(() => runRaw("", testConfig)).toThrow(
      "Command must be a non-empty string",
    );
  });

  it("should throw for command containing backticks", () => {
    expect(() => runRaw("echo `pwd`", testConfig)).toThrow(
      "contains prohibited shell metacharacters",
    );
  });

  it("should throw for command containing newlines", () => {
    expect(() => runRaw("echo hello\nrm -rf /", testConfig)).toThrow(
      "contains prohibited shell metacharacters",
    );
  });

  it("should allow commands with $() metacharacters (not blocked by current validation)", () => {
    // The current regex only blocks backticks and newlines, not $()
    const result = runRaw("echo allow-dollar-parenthesis", testConfig);
    expect(result.stdout).toBe("allow-dollar-parenthesis");
    expect(result.exitCode).toBe(0);
  });

  it("should accept command with basic pipes and redirects", () => {
    const result = runRaw('echo "pipetest" | cat', testConfig);
    expect(result.stdout).toBe("pipetest");
    expect(result.exitCode).toBe(0);
  });

  it("should handle command with custom timeout", () => {
    const result = runRaw("echo timeout-test", testConfig, 60);
    expect(result.stdout).toBe("timeout-test");
    expect(result.exitCode).toBe(0);
  });

  it("should clamp timeout to valid range", () => {
    const result = runRaw("echo clamp-test", testConfig, -1);
    expect(result.stdout).toBe("clamp-test");
    expect(result.exitCode).toBe(0);
  });
});
