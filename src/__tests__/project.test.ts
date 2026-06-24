import { describe, it, expect } from "vitest";
import { info, readResource } from "../tools/project.js";
import type { BetterMcpConfig } from "../config.js";

const testConfig: BetterMcpConfig = {
  project: "better-mcp",
  root: "/tmp/better-mcp",
  name: "Better MCP Test",
  description: "Test instance for development",
  stack: ["typescript", "node"],
  tools: {
    fs: {
      allowedPaths: ["/tmp/better-mcp"],
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

const minimalConfig: BetterMcpConfig = {
  project: "minimal",
  root: "/nonexistent-path",
  tools: {},
};

const configNoResources: BetterMcpConfig = {
  project: "no-resources",
  root: "/tmp",
  tools: {},
};

describe("project.info", () => {
  it("should return project info with basic fields", () => {
    const result = info(testConfig);
    expect(result.project).toBe("better-mcp");
    expect(result.name).toBe("Better MCP Test");
    expect(result.description).toBe("Test instance for development");
    expect(result.root).toBe("/tmp/better-mcp");
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
    // The project has package.json, tsconfig.json
    expect(result.hasConfig.node).toBe(true);
    expect(result.hasConfig.typescript).toBe(true);
  });

  it("should return resources with resolved absolute paths", () => {
    const result = info(testConfig);
    expect(result.resources.readme).toBe("/tmp/better-mcp/README.md");
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
      root: "/tmp",
      tools: {} as BetterMcpConfig["tools"],
    };
    const result = info(config);
    expect(result.enabledTools).toContain("git");
  });

  it("should exclude git from enabledTools when git.enabled is false", () => {
    const config = {
      ...minimalConfig,
      root: "/tmp",
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
      root: "/tmp",
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
    expect(result.path).toBe("/tmp/better-mcp/README.md");
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
      root: "/tmp",
      tools: {},
      resources: {
        missing: "nonexistent-file-that-does-not-exist.txt",
      },
    };
    const config2: BetterMcpConfig = {
      ...config,
      resources: {
        missing: "/tmp/nonexistent-file-test-12345.txt",
      },
    };
    expect(() => readResource("missing", config2)).toThrow(
      'Resource file not found: "missing"',
    );
  });

  it("should include available resources in error message", () => {
    expect(() => readResource("bad-name", testConfig)).toThrow(
      "readme",
    );
  });
});
