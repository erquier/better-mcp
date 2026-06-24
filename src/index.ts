#!/usr/bin/env node

import { startServer } from "./server.js";
import { runInit } from "./init.js";

// Usage:
//   better-mcp                    → uses better-mcp.json (or auto-detected config) from cwd (stdio)
//   better-mcp init [--force]     → write a better-mcp.json auto-detected from cwd, then exit
//   better-mcp --http             → HTTP/SSE on port 3100
//   better-mcp --http --port 8080 → HTTP/SSE on port 8080
//   better-mcp --http --host 0.0.0.0 → bind to all interfaces (default: 127.0.0.1)
//   better-mcp --config path/to/config.json → loads custom config
//   better-mcp path/to/config.json → loads custom config (stdio)

const args = process.argv.slice(2);

// `better-mcp init` — scaffold a config and exit (no server).
if (args[0] === "init") {
  runInit(process.cwd(), { force: args.includes("--force") });
  process.exit(0);
}

let configPath: string | undefined;
let transport: "stdio" | "http" | undefined;
let port: number | undefined;
let host: string | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === "--http") {
    transport = "http";
  } else if (arg === "--port" && i + 1 < args.length) {
    port = parseInt(args[++i], 10);
  } else if (arg === "--host" && i + 1 < args.length) {
    host = args[++i];
  } else if (arg === "--config" && i + 1 < args.length) {
    configPath = args[++i];
  } else if (arg === "run" && i + 1 < args.length) {
    configPath = args[++i];
  } else if (arg === "run") {
    // just "run" with no path arg — will use default path
  } else if (!arg.startsWith("-") && !configPath) {
    configPath = arg;
  }
}

startServer(configPath, { transport, port, host }).catch((err) => {
  console.error("better-mcp fatal error:", err);
  process.exit(1);
});
