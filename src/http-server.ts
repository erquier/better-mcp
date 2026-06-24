import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

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
  transport: HttpServerTransport;
}

/**
 * Creates and starts an HTTP server that exposes MCP over SSE transport.
 * Returns the server instance and the transport (for connecting to the MCP Server).
 */
export function createHttpServer(options: HttpServerOptions): http.Server {
  const { transport } = options;
  const port = options.port ?? 3100;

  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
    res.setHeader("Access-Control-Max-Age", "86400");

    // Handle OPTIONS (preflight)
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
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
    console.error(`[HTTP] better-mcp HTTP server listening on http://localhost:${port}`);
    console.error(`[HTTP] SSE endpoint: http://localhost:${port}/mcp (GET)`);
    console.error(`[HTTP] MCP endpoint: http://localhost:${port}/mcp (POST)`);
    console.error(`[HTTP] Health endpoint: http://localhost:${port}/health (GET)`);
  });

  server.on("error", (err) => {
    console.error(`[HTTP] Server error:`, err);
  });

  server.listen(port);

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
