import { spawnSync } from "child_process";
import type { BetterMcpConfig } from "../config.js";

type PsqlResult = { stdout: string; stderr: string; status: number | null };

/**
 * Execute a raw SQL query (read-only) against the configured database.
 */
export function query(
  sql: string,
  config: BetterMcpConfig,
  maxRows = 500
): { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean } {
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

  // Sanitize: only allow SELECT queries in read-only mode
  const trimmed = sql.trim().toUpperCase();
  if (dbConfig.readOnly !== false && !trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
    throw new Error("Only SELECT and WITH queries are allowed in read-only mode");
  }

  // Limit rows
  const limitedSql = sql.trim().endsWith(";") ? sql.trim() : sql.trim() + ";";
  const finalSql = maxRows
    ? `SELECT * FROM (${limitedSql.slice(0, -1)}) AS _sub LIMIT ${maxRows + 1}`
    : limitedSql;

  const result = runPsql(dbConfig.url, finalSql, "Query");
  const output = result.stdout;

  const lines = output.split("\n").filter(Boolean);
  if (lines.length === 0) {
    return { columns: [], rows: [], rowCount: 0, truncated: false };
  }

  // Try to parse as tab-separated
  const headerLine = lines.shift() || "";
  const columns = headerLine.split("\t").map((c) => c.trim()).filter(Boolean);

  const rows = lines.map((line) => {
    const values = line.split("\t");
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col] = values[i]?.trim() ?? null;
    });
    return row;
  });

  const truncated = rows.length > maxRows;
  if (truncated) {
    rows.length = maxRows;
  }

  return { columns, rows, rowCount: rows.length, truncated };
}

/**
 * Get database schema (tables, columns, types, indexes).
 */
export function schema(
  config: BetterMcpConfig,
  schemas?: string[]
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

  const result = runPsql(dbConfig.url, sql, "Schema query");
  const output = result.stdout;

  const lines = output.split("\n").filter(Boolean);
  const tableMap = new Map<string, SchemaTable>();

  for (const line of lines) {
    const [schemaName, tableName, columnName, dataType, isNullable, columnDefault, constraintType] =
      line.split("\t").map((s) => s?.trim());

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
 * Run psql with arguments array to prevent shell injection.
 */
function runPsql(url: string, sql: string, operation: string): PsqlResult {
  // Basic URL validation — reject non-postgres URLs
  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://") && !url.startsWith("psql://")) {
    throw new Error("Invalid database URL scheme");
  }

  // URL length limit
  if (url.length > 2000) {
    throw new Error("Database URL exceeds maximum length");
  }

  const args = [
    url,
    "-t",
    "-A",
    "-F", "\t",
    "--no-align",
    "-c", sql,
  ];

  const result = spawnSync("psql", args, {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error || result.status !== 0) {
    throw new Error(`${operation} failed`);
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
