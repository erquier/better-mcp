import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type { HttpConfig } from "./config.js";

// ─── SSE Transport (implements MCP Transport for HTTP/SSE) ──────────────

export class HttpServerTransport implements Transport {
  private _sseResponse: http.ServerResponse | null = null;
  private _sessionId: string;
  private _endpoint: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  constructor(endpoint: string) {
    this._endpoint = endpoint;
    this._sessionId = randomUUID();
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Start the transport. This is called by Server.connect().
   * For HTTP/SSE transport, connections are managed per-request,
   * so start() is a no-op. The SSE priming event is sent when
   * handleGetRequest() is called.
   */
  async start(): Promise<void> {
    // No-op: SSE priming happens in handleGetRequest()
  }

  /**
   * Called by the HTTP GET handler to establish the SSE stream.
   * Sets up the SSE response headers, sends the endpoint event, and stores the response.
   */
  handleGetRequest(res: http.ServerResponse): void {
    this._sseResponse = res;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send the endpoint event with session ID
    const endpointUrl = new URL(this._endpoint, "http://localhost");
    endpointUrl.searchParams.set("sessionId", this._sessionId);
    const relativeUrl = endpointUrl.pathname + endpointUrl.search + endpointUrl.hash;
    res.write(`event: endpoint\ndata: ${relativeUrl}\n\n`);

    res.on("close", () => {
      this._sseResponse = null;
      this.onclose?.();
    });
  }

  /**
   * Handle a raw message (from any source) — parses and dispatches to onmessage.
   */
  async handleMessage(message: unknown, extra?: MessageExtraInfo): Promise<void> {
    if (this.onmessage) {
      await this.onmessage(message as JSONRPCMessage, extra);
    }
  }

  /**
   * Handle an incoming POST message from the client.
   * Parses the JSON body and dispatches to onmessage.
   */
  async handlePostMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this._sseResponse) {
      res.writeHead(500).end("SSE connection not established");
      return;
    }

    // Read the body
    const body = await readBody(req);
    if (!body) {
      res.writeHead(400).end("Empty request body");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }

    // Dispatch to the MCP protocol handler
    try {
      await this.handleMessage(parsed);
      res.writeHead(202).end("Accepted");
    } catch (err: unknown) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      res.writeHead(400).end(String(err));
    }
  }

  /**
   * Send a JSON-RPC message to the client via SSE.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._sseResponse) {
      throw new Error("Not connected");
    }
    this._sseResponse.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  /**
   * Send a custom SSE event to the client (used for auth confirmations in interactive mode).
   */
  sendEvent(eventName: string, data: unknown): void {
    if (!this._sseResponse) {
      // No SSE connection — fall back silently
      return;
    }
    this._sseResponse.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Close the SSE connection.
   */
  async close(): Promise<void> {
    this._sseResponse?.end();
    this._sseResponse = null;
    this.onclose?.();
  }
}

// ─── HTTP Server ────────────────────────────────────────────────────────

export interface HttpServerOptions {
  port?: number;
  host?: string;
  transport: HttpServerTransport;
  httpConfig?: HttpConfig;
}

/**
 * Compare two strings using timing-safe comparison.
 * Handles different-length inputs safely.
 */
function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) {
    // Use timingSafeEqual on the first buffer length anyway to avoid leaking info
    // but with differing lengths we know it'll be false
    const fake = Buffer.alloc(aBuf.length, 0);
    timingSafeEqual(aBuf, fake);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Set CORS headers on a response based on the origin and configured allowlist.
 * Returns true if the request should proceed, false if it should be rejected.
 */
function handleCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsOrigins?: string[],
): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;

  // Determine allowed origin
  let allowedOrigin = "";

  if (corsOrigins && corsOrigins.length > 0) {
    // Allowlist mode: only allow configured origins
    if (origin && corsOrigins.includes(origin)) {
      allowedOrigin = origin;
    }
  } else if (origin && host) {
    // Same-origin check: origin matches Host header
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.host;
      // For same-origin, check host (including port)
      if (originHost === host || originHost === `127.0.0.1:${host.split(":")[1]}` || originHost === `localhost:${host.split(":")[1]}`) {
        allowedOrigin = origin;
      } else {
        // Check for localhost/127.0.0.1 variations
        const hostPort = host.split(":");
        const hostName = hostPort[0];
        const hostPortNum = hostPort[1];
        if ((hostName === "127.0.0.1" || hostName === "localhost" || hostName === "0.0.0.0") &&
            (originHost === `127.0.0.1:${hostPortNum}` || originHost === `localhost:${hostPortNum}`)) {
          allowedOrigin = origin;
        }
      }
    } catch {
      // Invalid origin URL — don't allow
    }
  }

  if (origin && !allowedOrigin) {
    // Origin does not match — return 403 for non-OPTIONS requests
    if (req.method !== "OPTIONS") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Origin not allowed" }));
      return false;
    }
    // For OPTIONS, still return 403 if origin isn't allowed
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Origin not allowed" }));
    return false;
  }

  // Set CORS headers
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  } else if (origin) {
    // Origin present but not allowed — already handled above (403 returned)
    // Don't set any Access-Control-Allow-Origin
  }
  // Only set CORS headers when we actually allow the request
  if (allowedOrigin || req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  return true;
}

/**
 * Validate the Authorization header against the configured token.
 * Returns true if authorized, false if not.
 */
function checkAuthHeader(
  req: http.IncomingMessage,
  authToken: string | undefined,
): boolean {
  // No token configured — still require one (generate a random one at startup)
  if (!authToken) {
    // This should never happen because we ensure a token exists before calling
    return false;
  }

  // GET /health is public
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return false;
  }

  // Parse "Bearer <token>"
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return false;
  }

  const providedToken = parts[1];

  // Reject tokens longer than 1024 bytes to prevent header abuse
  if (Buffer.byteLength(providedToken, "utf-8") > 1024) {
    return false;
  }

  return safeCompare(providedToken, authToken);
}

/**
 * Creates and starts an HTTP server that exposes MCP over SSE transport.
 * Returns the server instance and the transport (for connecting to the MCP Server).
 */
export function createHttpServer(options: HttpServerOptions): http.Server {
  const { transport, httpConfig } = options;
  const port = options.port ?? 3100;
  const host = options.host ?? httpConfig?.host ?? "127.0.0.1";
  const corsOrigins = httpConfig?.corsOrigins;

  // Resolve auth token
  let authToken = httpConfig?.authToken;
  if (!authToken) {
    // Generate a random token and print to stderr
    authToken = randomUUID();
    console.error(`⚠️ HTTP auth token: ${authToken}`);
  }

  const server = http.createServer((req, res) => {
    // ── CORS check first ──
    if (!handleCors(req, res, corsOrigins)) {
      return; // response already sent
    }

    // Handle OPTIONS (preflight) — after CORS check
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Authentication check (BEFORE any routing, except health) ──
    if (!checkAuthHeader(req, authToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      // Health endpoint
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          project: "better-mcp",
          uptime: process.uptime(),
        }),
      );
      return;
    }

    if (req.method === "GET" && pathname === "/mcp") {
      // SSE stream endpoint
      console.error(`[HTTP] Client connected to SSE stream (session: ${transport.sessionId})`);
      transport.handleGetRequest(res);
      return;
    }

    if (req.method === "POST" && pathname === "/mcp") {
      // Handle MCP messages — delegate to the transport
      transport.handlePostMessage(req, res).catch((err: unknown) => {
        console.error(`[HTTP] Error in POST handler:`, err);
      });
      return;
    }

    // 404
    res.writeHead(404).end("Not Found");
  });

  // Log when server starts
  server.on("listening", () => {
    const addr = server.address();
    const bindAddr = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : `${host}:${port}`;
    console.error(`[HTTP] better-mcp HTTP server listening on http://${bindAddr}`);
    console.error(`[HTTP] SSE endpoint: http://${bindAddr}/mcp (GET)`);
    console.error(`[HTTP] MCP endpoint: http://${bindAddr}/mcp (POST)`);
    console.error(`[HTTP] Health endpoint: http://${bindAddr}/health (GET)`);
    if (authToken) {
      console.error(`[HTTP] Auth: Bearer token required`);
    }
  });

  server.on("error", (err) => {
    console.error(`[HTTP] Server error:`, err);
  });

  server.listen(port, host);

  return server;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Read the body from an IncomingMessage as a string.
 * Uses only built-in Node.js stream APIs.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
