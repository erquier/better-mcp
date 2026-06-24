#!/usr/bin/env node

import { startServer } from "./server.js";

// Usage:
//   better-mcp                    → loads better-mcp.json from cwd
//   better-mcp path/to/config.json → loads custom config
//   better-mcp run                → loads better-mcp.json from cwd
//   better-mcp run path/to/config.json → loads custom config
//   better-mcp --config path/to/config.json → loads custom config

const args = process.argv.slice(2);
let configPath: string | undefined;

if (args[0] === "run") {
  configPath = args[1];
} else if (args[0] === "--config") {
  configPath = args[1];
} else if (args[0] && !args[0].startsWith("-")) {
  configPath = args[0];
}

startServer(configPath).catch((err) => {
  console.error("better-mcp fatal error:", err);
  process.exit(1);
});
