import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, resolveEnv, type BetterMcpConfig } from "../config.js";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";

const TEST_CONFIG_PATH = resolve(process.cwd(), "test-config.json");

describe("resolveEnv", () => {
  beforeEach(() => {
    process.env.TEST_VAR = "test_value";
    process.env.ANOTHER_VAR = "another_value";
  });

  afterEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.ANOTHER_VAR;
  });

  it("should replace ${VAR} with env var value", () => {
    expect(resolveEnv("hello ${TEST_VAR}")).toBe("hello test_value");
  });

  it("should replace multiple env vars", () => {
    expect(resolveEnv("${TEST_VAR} ${ANOTHER_VAR}")).toBe(
      "test_value another_value",
    );
  });

  it("should return empty string for missing env var", () => {
    expect(resolveEnv("prefix_${MISSING_VAR}_suffix")).toBe("prefix__suffix");
  });

  it("should return the value unchanged if no env vars", () => {
    expect(resolveEnv("plain text")).toBe("plain text");
  });

  it("should return value as-is if length > 5000", () => {
    const long = "a".repeat(5001);
    expect(resolveEnv(long)).toBe(long);
  });

  it("should handle empty env var value in short string", () => {
    process.env.EMPTY_VAR = "";
    expect(resolveEnv("${EMPTY_VAR}")).toBe("");
    delete process.env.EMPTY_VAR;
  });

  it("should limit env var expansion to 10000 chars", () => {
    process.env.LARGE_VAR = "a".repeat(15000);
    const result = resolveEnv("${LARGE_VAR}");
    // When envVal.length > 10000, it returns ""
    expect(result).toBe("");
    delete process.env.LARGE_VAR;
  });
});

describe("loadConfig", () => {
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(origCwd);
  });

  it("should load config from explicit path (test-config.json)", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.project).toBe("better-mcp");
    expect(config.root).toBe("/tmp/better-mcp");
    expect(config.name).toBe("Better MCP Test");
    expect(config.description).toBe("Test instance for development");
    expect(config.stack).toEqual(["typescript", "node"]);
  });

  it("should load config with fs allowedPaths", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.tools.fs).toBeDefined();
    expect(config.tools.fs?.allowedPaths).toContain("/tmp/better-mcp");
  });

  it("should load config with shell commands", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.tools.shell).toBeDefined();
    expect(config.tools.shell?.commands.build).toBe("npx tsc");
    expect(config.tools.shell?.commands.test).toBe("echo 'tests ok'");
  });

  it("should load config with git enabled", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.tools.git).toBeDefined();
    expect(config.tools.git?.enabled).toBe(true);
  });

  it("should load config with resources", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.resources).toBeDefined();
    expect(config.resources?.readme).toBe("README.md");
  });

  it("should throw when an EXPLICIT config path is not found", () => {
    expect(() => loadConfig("/nonexistent/path.json")).toThrow(
      "Config file not found: /nonexistent/path.json",
    );
  });

  it("auto-detects a config when no better-mcp.json is present (zero-config drop-in)", () => {
    const dir = realpathSync(mkdtempSync(resolve(tmpdir(), "bmcp-cfg-")));
    process.chdir(dir); // afterEach restores cwd
    const config = loadConfig();
    expect(config.root).toBe(dir);
    expect(config.tools?.fs?.allowedPaths).toEqual([dir]);
  });

  it("should resolve env vars in db.url", () => {
    process.env.DB_URL = "postgres://localhost/mydb";
    const configPath = resolve(
      process.cwd(),
      "src/__tests__/fixtures/config-with-db.json",
    );
    mkdirSync(resolve(process.cwd(), "src/__tests__/fixtures"), {
      recursive: true,
    });
    writeFileSync(
      configPath,
      JSON.stringify({
        project: "test-project",
        root: "/tmp",
        tools: {
          db: { url: "${DB_URL}" },
        },
      }),
    );
    const config = loadConfig(configPath);
    expect(config.tools.db?.url).toBe("postgres://localhost/mydb");
    unlinkSync(configPath);
    delete process.env.DB_URL;
  });
});

describe("config validation", () => {
  it("should throw if project is missing", () => {
    expect(() =>
      loadConfigWithRaw({
        root: "/tmp",
        tools: {},
      }),
    ).toThrow("Config missing: project");
  });

  it("should throw if root is missing", () => {
    expect(() =>
      loadConfigWithRaw({
        project: "test",
        tools: {},
      }),
    ).toThrow("Config missing: root");
  });

  it("should throw if fs.allowedPaths is empty", () => {
    expect(() =>
      loadConfigWithRaw({
        project: "test",
        root: "/tmp",
        tools: {
          fs: { allowedPaths: [] },
        },
      }),
    ).toThrow("fs.allowedPaths must be a non-empty array");
  });

  it("should throw if fs.allowedPaths contains non-absolute path", () => {
    expect(() =>
      loadConfigWithRaw({
        project: "test",
        root: "/tmp",
        tools: {
          fs: { allowedPaths: ["relative/path"] },
        },
      }),
    ).toThrow("fs.allowedPaths must be absolute: relative/path");
  });

  it("should throw if shell.commands is not an object", () => {
    expect(() =>
      loadConfigWithRaw({
        project: "test",
        root: "/tmp",
        tools: {
          shell: { commands: "not-an-object" as any },
        },
      }),
    ).toThrow("shell.commands must be an object");
  });

  it("should throw if shell.commands value is not a string", () => {
    expect(() =>
      loadConfigWithRaw({
        project: "test",
        root: "/tmp",
        tools: {
          shell: { commands: { build: 123 as any } },
        },
      }),
    ).toThrow("shell.commands.build must be a string");
  });

  it("should throw if db is enabled but db.url missing", () => {
    expect(() =>
      loadConfigWithRaw({
        project: "test",
        root: "/tmp",
        tools: {
          db: {} as any,
        },
      }),
    ).toThrow("db.url is required when db tools are enabled");
  });

  it("should accept valid minimal config", () => {
    const config = loadConfigWithRaw({
      project: "minimal",
      root: "/tmp",
      tools: {},
    });
    expect(config.project).toBe("minimal");
  });
});

/**
 * Helper: write a temp config, load it, clean up.
 */
function loadConfigWithRaw(raw: Record<string, unknown>): BetterMcpConfig {
  const tempPath = resolve(
    process.cwd(),
    `__temp_test_config_${Date.now()}.json`,
  );
  try {
    writeFileSync(tempPath, JSON.stringify(raw));
    return loadConfig(tempPath);
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}
