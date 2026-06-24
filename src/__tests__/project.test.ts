import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { info, readResource } from "../tools/project.js";
import type { BetterMcpConfig } from "../config.js";

const tmpDir = mkdtempSync(join(tmpdir(), "better-mcp-project-test-"));

// Write fixture files
writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test-project", version: "1.0.0" }));
writeFileSync(join(tmpDir, "README.md"), "# Test Project\n\nThis is a test.");
writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));

const testConfig: BetterMcpConfig = {
  project: "test-project",
  root: tmpDir,
  name: "Better MCP Test",
  description: "Test instance for development",
  stack: ["typescript", "node"],
  tools: {
    fs: {
      allowedPaths: [tmpDir],
    },
    shell: {
      commands: {
        build: "npx tsc",
        test: "echo 'tests ok'",
      },
    },
    git: {
      enabled: true,
    },
  },
  resources: {
    readme: "README.md",
  },
};

const nonexistentDir = mkdtempSync(join(tmpdir(), "better-mcp-nonexistent-"));

const minimalConfig: BetterMcpConfig = {
  project: "minimal",
  root: nonexistentDir,
  tools: {},
};

const configNoResources: BetterMcpConfig = {
  project: "no-resources",
  root: tmpDir,
  tools: {},
};

describe("project.info", () => {
  it("should return project info with basic fields", () => {
    const result = info(testConfig);
    expect(result.project).toBe("test-project");
    expect(result.name).toBe("Better MCP Test");
    expect(result.description).toBe("Test instance for development");
    expect(result.root).toBe(tmpDir);
    expect(result.stack).toEqual(["typescript", "node"]);
  });

  it("should report enabled tools", () => {
    const result = info(testConfig);
    expect(result.enabledTools).toContain("filesystem");
    expect(result.enabledTools).toContain("shell");
    expect(result.enabledTools).toContain("git");
  });

  it("should report available commands from shell config", () => {
    const result = info(testConfig);
    expect(result.availableCommands).toContain("build");
    expect(result.availableCommands).toContain("test");
  });

  it("should return directoryCount, fileCount as numbers", () => {
    const result = info(testConfig);
    expect(typeof result.directoryCount).toBe("number");
    expect(typeof result.fileCount).toBe("number");
    expect(typeof result.totalSizeBytes).toBe("number");
  });

  it("should detect config files like package.json", () => {
    const result = info(testConfig);
    expect(result.hasConfig.node).toBe(true);
    expect(result.hasConfig.typescript).toBe(true);
  });

  it("should return resources with resolved absolute paths", () => {
    const result = info(testConfig);
    expect(result.resources.readme).toBe(join(tmpDir, "README.md"));
  });

  it("should fallback name to project if name is missing", () => {
    const result = info(minimalConfig);
    expect(result.name).toBe("minimal");
  });

  it("should return empty strings for missing description/stack", () => {
    const result = info(minimalConfig);
    expect(result.description).toBe("");
    expect(result.stack).toEqual([]);
  });

  it("should handle non-existent root gracefully", () => {
    const result = info(minimalConfig);
    expect(result.directoryCount).toBe(0);
    expect(result.fileCount).toBe(0);
    expect(result.totalSizeBytes).toBe(0);
  });

  it("should include git in enabledTools when git.enabled is not false", () => {
    const config = {
      ...minimalConfig,
      root: tmpDir,
      tools: {} as BetterMcpConfig["tools"],
    };
    const result = info(config);
    expect(result.enabledTools).toContain("git");
  });

  it("should exclude git from enabledTools when git.enabled is false", () => {
    const config = {
      ...minimalConfig,
      root: tmpDir,
      tools: {
        git: { enabled: false },
      },
    };
    const result = info(config);
    expect(result.enabledTools).not.toContain("git");
  });

  it("should return empty availableCommands when no shell config", () => {
    const result = info({
      ...minimalConfig,
      root: tmpDir,
      tools: {},
    });
    expect(result.availableCommands).toEqual([]);
  });
});

describe("project.readResource", () => {
  it("should read a valid resource by name", () => {
    const result = readResource("readme", testConfig);
    expect(result.name).toBe("readme");
    expect(result.content).toBeTruthy();
    expect(result.path).toBe(join(tmpDir, "README.md"));
  });

  it("should throw for unknown resource name", () => {
    expect(() => readResource("nonexistent", testConfig)).toThrow(
      'Resource "nonexistent" not found',
    );
  });

  it("should throw when no resources configured", () => {
    expect(() => readResource("anything", configNoResources)).toThrow(
      'Resource "anything" not found',
    );
  });

  it("should throw when resource file does not exist", () => {
    const config: BetterMcpConfig = {
      project: "test",
      root: tmpDir,
      tools: {},
      resources: {
        missing: join(tmpDir, "nonexistent-file-that-does-not-exist.txt"),
      },
    };
    expect(() => readResource("missing", config)).toThrow(
      'Resource file not found: "missing"',
    );
  });

  it("should include available resources in error message", () => {
    expect(() => readResource("bad-name", testConfig)).toThrow(
      "readme",
    );
  });
});
