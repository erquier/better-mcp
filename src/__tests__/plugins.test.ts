import { describe, it, expect } from "vitest";
import {
  validatePlugin,
  discoverPluginFiles,
  loadPluginFile,
  discoverPlugins,
  getPluginTools,
  getPluginSummary,
  type LoadedPlugin,
} from "../plugins.js";
import type { BetterMcpConfig } from "../config.js";
import { resolve } from "path";

describe("validatePlugin", () => {
  it("should reject null/undefined", () => {
    const errors = validatePlugin(null);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should reject non-object", () => {
    const errors = validatePlugin("string");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should reject missing name", () => {
    const errors = validatePlugin({ version: "1.0", tools: [] });
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("should reject empty name", () => {
    const errors = validatePlugin({ name: "", version: "1.0", tools: [] });
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("should reject missing version", () => {
    const errors = validatePlugin({ name: "test", tools: [] });
    expect(errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("should reject non-array tools", () => {
    const errors = validatePlugin({ name: "test", version: "1.0", tools: "not-array" });
    expect(errors.some((e) => e.includes("tools"))).toBe(true);
  });

  it("should reject empty tools array", () => {
    const errors = validatePlugin({ name: "test", version: "1.0", tools: [] });
    expect(errors.some((e) => e.includes("tools"))).toBe(true);
  });

  it("should reject tool without handler", () => {
    const errors = validatePlugin({
      name: "test",
      version: "1.0",
      tools: [{ name: "t1", description: "d", inputSchema: { type: "object" } }],
    });
    expect(errors.some((e) => e.includes("handler"))).toBe(true);
  });

  it("should reject tool without inputSchema", () => {
    const errors = validatePlugin({
      name: "test",
      version: "1.0",
      tools: [{ name: "t1", description: "d", handler: () => {} }],
    });
    expect(errors.some((e) => e.includes("inputSchema"))).toBe(true);
  });

  it("should accept valid plugin", () => {
    const errors = validatePlugin({
      name: "my-plugin",
      version: "1.0.0",
      description: "A test plugin",
      tools: [
        {
          name: "my_tool",
          description: "Does something",
          inputSchema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });
    expect(errors).toEqual([]);
  });
});

describe("discoverPluginFiles", () => {
  it("should find .ts files in plugins directory", () => {
    const pluginsDir = resolve(process.cwd(), "plugins");
    const files = discoverPluginFiles(pluginsDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.some((f) => f.endsWith("example-echo.ts"))).toBe(true);
  });

  it("should return empty for non-existent directory", () => {
    const files = discoverPluginFiles("/nonexistent/path");
    expect(files).toEqual([]);
  });
});

describe("loadPluginFile", () => {
  it("should load the example-echo plugin", async () => {
    const pluginsDir = resolve(process.cwd(), "plugins");
    const files = discoverPluginFiles(pluginsDir);
    const echoFile = files.find((f) => f.endsWith("example-echo.ts"));
    expect(echoFile).toBeTruthy();

    const plugin = await loadPluginFile(echoFile!);
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe("example-echo");
    expect(plugin!.version).toBe("1.0.0");
    expect(plugin!.tools.length).toBe(2);
    expect(plugin!.tools[0].name).toBe("echo");
    expect(plugin!.tools[1].name).toBe("greet");
  });
});

describe("getPluginTools", () => {
  it("should prefix tool names with plugin_<name>_", () => {
    const plugins: LoadedPlugin[] = [
      {
        name: "test",
        version: "1.0",
        description: "",
        tools: [{ name: "tool1", description: "d1", inputSchema: { type: "object" as const }, handler: async () => ({ content: [] }) }],
        filePath: "/test.ts",
      },
    ];
    const tools = getPluginTools(plugins);
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("plugin_test_tool1");
  });
});

describe("getPluginSummary", () => {
  it("should return summary with tool count", () => {
    const plugins: LoadedPlugin[] = [
      {
        name: "p1",
        version: "1.0",
        description: "desc1",
        tools: [{ name: "t1", description: "", inputSchema: { type: "object" as const }, handler: async () => ({ content: [] }) }],
        filePath: "/p1.ts",
      },
    ];
    const summary = getPluginSummary(plugins);
    expect(summary[0].name).toBe("p1");
    expect(summary[0].version).toBe("1.0");
    expect(summary[0].toolCount).toBe(1);
  });
});

describe("discoverPlugins (integration)", () => {
  it("should load example plugin from plugins/ directory", async () => {
    const config: BetterMcpConfig = {
      project: "test",
      root: process.cwd(),
      tools: {},
    };
    const plugins = await discoverPlugins(config, process.cwd());
    const echoPlugin = plugins.find((p) => p.name === "example-echo");
    expect(echoPlugin).toBeDefined();
    expect(echoPlugin!.tools.length).toBe(2);
  });

  it("should respect allowlist", async () => {
    const config: BetterMcpConfig = {
      project: "test",
      root: process.cwd(),
      tools: {
        plugins: {
          allowlist: ["nonexistent-plugin"],
        },
      },
    };
    const plugins = await discoverPlugins(config, process.cwd());
    expect(plugins.length).toBe(0);
  });

  it("should respect enabled: false", async () => {
    const config: BetterMcpConfig = {
      project: "test",
      root: process.cwd(),
      tools: {
        plugins: {
          enabled: false,
        },
      },
    };
    const plugins = await discoverPlugins(config, process.cwd());
    expect(plugins.length).toBe(0);
  });
});
