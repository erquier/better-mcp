import { writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { buildAutoConfig } from "./config.js";

/**
 * `better-mcp init` — scan the working directory and write a better-mcp.json
 * pre-filled with auto-detected settings, so configuring a project is editing a
 * generated file instead of writing one from scratch.
 */
export function runInit(root: string = process.cwd(), opts: { force?: boolean } = {}): void {
  const path = resolve(root, "better-mcp.json");
  if (existsSync(path) && !opts.force) {
    console.error(`better-mcp.json already exists at ${path}. Use \`better-mcp init --force\` to overwrite.`);
    return;
  }

  const config = buildAutoConfig(root);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const cmds = config.tools?.shell?.commands ? Object.keys(config.tools.shell.commands) : [];
  const res = config.resources ? Object.keys(config.resources) : [];
  console.error(`✓ Wrote ${path}`);
  console.error(`  project:   ${config.name}`);
  console.error(`  stack:     ${(config.stack || []).join(", ") || "(none detected)"}`);
  console.error(`  commands:  ${cmds.join(", ") || "(none)"}`);
  console.error(`  database:  ${config.tools?.db ? "detected (read-only)" : "(none)"}`);
  console.error(`  resources: ${res.join(", ") || "(none)"}`);
  console.error(`Edit the file to customize, then run \`better-mcp\` (stdio).`);
}
