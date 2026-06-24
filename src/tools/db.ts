import { spawnSync } from "child_process";
import type { BetterMcpConfig } from "../config.js";
import type { ToolDefinition, ToolContext } from "../tool-registry.js";
import { hasDestructiveCte } from "../auth.js";

type PsqlResult = { stdout: string; stderr: string; status: number | null };

/**
 * Parse a PostgreSQL connection string, extracting the password for
 * PGPASSWORD env var use and returning a sanitised URL without the password.
 */
function parsePgConnectionString(
  url: string,
): { cleanUrl: string; password?: string } {
  const parsed = new URL(url);
  const password = parsed.password || undefined;

  if (password) {
    // Clear the password from the URL so it doesn't appear in argv
    parsed.password = "";
    return { cleanUrl: parsed.toString(), password };
  }

  return { cleanUrl: url };
}

/**
 * Execute a raw SQL query (read-only) against the configured database.
 * Returns results as structured JSON parsed from psql JSON output.
 */
export function query(
  sql: string,
  config: BetterMcpConfig,
  maxRows = 500,
): {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
} {
  const dbConfig = config.tools!.db;
  if (!dbConfig?.url) {
    throw new Error("Database not configured");
  }

  // Validate input
  if (typeof sql !== "string" || sql.length === 0) {
    throw new Error("SQL query must be a non-empty string");
  }
  if (sql.length > 100_000) {
    throw new Error("SQL query exceeds maximum length of 100,000 characters");
  }

  // Sanitize: only allow SELECT/WITH/EXPLAIN queries in read-only mode
  // (first-pass filter — engine-level enforcement is done via SET TRANSACTION)
  const trimmed = sql.trim().toUpperCase();
  if (
    dbConfig.readOnly !== false &&
    !trimmed.startsWith("SELECT") &&
    !trimmed.startsWith("WITH") &&
    !trimmed.startsWith("EXPLAIN")
  ) {
    throw new Error(
      "Only SELECT, WITH, and EXPLAIN queries are allowed in read-only mode",
    );
  }

  // Limit rows: wrap in a subquery with LIMIT
  const limitedSql = maxRows
    ? `SELECT * FROM (${sql.trim().replace(/;$/, "")}) AS _sub LIMIT ${maxRows + 1}`
    : sql.trim().replace(/;$/, "");

  // Determine read-only mode preference
  // When maxRows > 0, default to "engine" for maximum safety
  const readOnlyMode =
    dbConfig.readOnlyMode ??
    (maxRows > 0 || dbConfig.readOnly !== false ? "engine" : "none");

  // If using wrapper mode, also check for destructive CTEs that bypass the allowlist
  if (readOnlyMode === "wrapper" && hasDestructiveCte(sql)) {
    throw new Error("Destructive CTEs not allowed in read-only mode");
  }

  const rows = runPsqlAndGetJson(dbConfig.url, limitedSql, "Query", {
    readOnlyMode,
  }) as Record<string, unknown>[];

  if (rows.length === 0) {
    return { columns: [], rows: [], rowCount: 0, truncated: false };
  }

  // Extract columns from the first row's keys
  const columns = Object.keys(rows[0]);

  const truncated = rows.length > maxRows;
  const resultRows = truncated ? rows.slice(0, maxRows) : rows;

  return {
    columns,
    rows: resultRows,
    rowCount: resultRows.length,
    truncated,
  };
}

/**
 * Get database schema (tables, columns, types, indexes).
 */
export function schema(
  config: BetterMcpConfig,
  schemas?: string[],
): { tables: SchemaTable[] } {
  const dbConfig = config.tools!.db;
  if (!dbConfig?.url) {
    throw new Error("Database not configured");
  }

  // Validate and sanitize schema names
  const schemaList = schemas?.length
    ? schemas
    : dbConfig.schemas?.length
      ? dbConfig.schemas
      : ["public"];

  for (const s of schemaList) {
    if (typeof s !== "string" || s.length === 0) {
      throw new Error("Schema names must be non-empty strings");
    }
    // Only allow valid SQL identifiers: alphanumeric + underscores
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
      throw new Error(`Invalid schema name: "${s}"`);
    }
  }

  // Use parameterized query via psql -v with properly escaped identifiers
  const schemaFilter = schemaList.map((s) => `'${s}'`).join(",");

  const sql = `
    SELECT
      t.table_schema,
      t.table_name,
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.column_default,
      tc.constraint_type
    FROM information_schema.tables t
    JOIN information_schema.columns c
      ON t.table_schema = c.table_schema
      AND t.table_name = c.table_name
    LEFT JOIN information_schema.key_column_usage kcu
      ON c.table_schema = kcu.table_schema
      AND c.table_name = kcu.table_name
      AND c.column_name = kcu.column_name
    LEFT JOIN information_schema.table_constraints tc
      ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
      AND kcu.table_name = tc.table_name
    WHERE t.table_type = 'BASE TABLE'
      AND t.table_schema IN (${schemaFilter})
    ORDER BY t.table_schema, t.table_name, c.ordinal_position
  `;

  const rows = runPsqlAndGetJson(dbConfig.url, sql, "Schema query", {
    readOnlyMode: "engine",
  }) as Record<string, string | null>[];

  const tableMap = new Map<string, SchemaTable>();

  for (const row of rows) {
    const schemaName = row.table_schema as string;
    const tableName = row.table_name as string;
    const columnName = row.column_name as string;
    const dataType = row.data_type as string;
    const isNullable = row.is_nullable as string;
    const columnDefault = row.column_default as string | null;
    const constraintType = row.constraint_type as string | null;

    if (!schemaName || !tableName || !columnName) continue;

    const key = `${schemaName}.${tableName}`;
    if (!tableMap.has(key)) {
      tableMap.set(key, {
        schema: schemaName,
        name: tableName,
        columns: [],
        indexes: [],
        rowCountEstimate: 0,
      });
    }

    const table = tableMap.get(key)!;
    table.columns.push({
      name: columnName,
      type: dataType,
      nullable: isNullable === "YES",
      default: columnDefault || null,
      isPrimaryKey: constraintType === "PRIMARY KEY",
    });
  }

  return { tables: Array.from(tableMap.values()) };
}

/**
 * Run a SQL query through psql and return the result as a parsed JSON array.
 * Wraps the user's SQL in a json_agg(row_to_json(...)) query for safe structured output
 * that handles tabs, newlines, NULLs, and other special characters correctly.
 */
function runPsqlAndGetJson(
  url: string,
  sql: string,
  operation: string,
  options?: { readOnlyMode?: string },
): unknown[] {
  // Wrap the SQL in a JSON aggregation query
  const jsonSql = `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (${sql}) t`;

  // Run with -t (tuples-only) and no alignment/separator flags since we're parsing JSON
  const result = runPsqlRaw(url, jsonSql, operation, options);
  const output = result.stdout.trim();

  if (!output) {
    return [];
  }

  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    throw new Error(
      `${operation} failed: could not parse JSON output from psql: ${(e as Error).message}`,
    );
  }
}

/**
 * Low-level psql execution returning raw stdout/stderr.
 * Uses -t (tuples-only) mode; no -A/-F flags since callers may want JSON.
 */
function runPsqlRaw(
  url: string,
  sql: string,
  operation: string,
  options?: { readOnlyMode?: string },
): PsqlResult {
  // Basic URL validation — reject non-postgres URLs
  if (
    !url.startsWith("postgres://") &&
    !url.startsWith("postgresql://") &&
    !url.startsWith("psql://")
  ) {
    throw new Error("Invalid database URL scheme");
  }

  // URL length limit
  if (url.length > 2000) {
    throw new Error("Database URL exceeds maximum length");
  }

  // Parse the connection string to extract password for PGPASSWORD env var
  const { cleanUrl, password } = parsePgConnectionString(url);

  // Build environment with PGPASSWORD if present
  const env: Record<string, string | undefined> = { ...process.env };
  if (password) {
    env.PGPASSWORD = password;
  }

  const args = [cleanUrl, "-t"];

  // Engine-level read-only enforcement: SET TRANSACTION before the query
  const readOnlyMode = options?.readOnlyMode ?? "engine";
  if (readOnlyMode === "engine") {
    args.push("-c", "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;");
  }

  // Add the actual query
  args.push("-c", sql);

  const result = spawnSync("psql", args, {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        "psql not found — the database tools require the PostgreSQL client (psql) on PATH.",
      );
    }
    throw new Error(`${operation} failed: ${err.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 500);
    throw new Error(
      detail
        ? `${operation} failed: ${detail}`
        : `${operation} failed (exit ${result.status})`,
    );
  }

  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

interface SchemaTable {
  schema: string;
  name: string;
  columns: SchemaColumn[];
  indexes: string[];
  rowCountEstimate: number;
}

interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

/**
 * Get database tool definitions for the MCP server.
 * Tools are only returned if at least one project has db tools enabled.
 */
export function getToolDefinitions(config: BetterMcpConfig, hasDb: boolean): ToolDefinition[] {
  if (!hasDb) return [];

  return [
    {
      name: "db_query",
      description: `Execute a SQL query against the project database. Only SELECT/WITH allowed in read-only mode.`,
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "SQL query" },
        },
        required: ["sql"],
      },
      requiresAuth: (args) => {
        const sql = args.sql;
        if (typeof sql === "string") {
          const trimmed = sql.trim().toUpperCase();
          return !trimmed.startsWith("SELECT") &&
            !trimmed.startsWith("WITH") &&
            !trimmed.startsWith("EXPLAIN");
        }
        return true;
      },
      handler: async (args, ctx) => {
        const projectConfig = ctx.project;
        const sql = args.sql;
        if (typeof sql !== "string" || sql.length === 0) {
          throw new Error("db_query requires a non-empty string 'sql'");
        }
        const maxRows = projectConfig.tools.db?.maxRows ?? 500;
        const result = query(sql, ctx.config, maxRows);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    },
    {
      name: "db_schema",
      description: "Get the complete database schema: tables, columns, types, nullable, defaults, primary keys.",
      inputSchema: {
        type: "object",
        properties: {
          schemas: {
            type: "array",
            items: { type: "string" },
            description: "Schema filter (default: from config or public)",
          },
        },
      },
      requiresAuth: () => false,
      handler: async (args, ctx) => {
        const projectConfig = ctx.project;
        const rawSchemas = args.schemas;
        let schemas: string[] | undefined;
        if (rawSchemas !== undefined) {
          if (!Array.isArray(rawSchemas)) {
            throw new Error("db_schema 'schemas' must be an array of strings");
          }
          schemas = rawSchemas.map((s: unknown) => {
            if (typeof s !== "string") throw new Error("db_schema 'schemas' must be an array of strings");
            return s;
          });
        }
        const result = schema(ctx.config, schemas);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    },
  ];
}
