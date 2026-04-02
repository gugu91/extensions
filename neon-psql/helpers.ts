import { delimiter } from "node:path";

import type { ResolvedConfig } from "./settings.js";

const READ_ONLY_LEAD_KEYWORDS = new Set(["select", "with", "show", "values", "table"]);
const SAFE_PSQL_INSPECTION_COMMANDS = new Set([
  "conninfo",
  "d",
  "da",
  "db",
  "dc",
  "dd",
  "dD",
  "df",
  "dFd",
  "dFp",
  "dFt",
  "dg",
  "di",
  "dl",
  "dm",
  "dn",
  "do",
  "dp",
  "ds",
  "dt",
  "dT",
  "du",
  "dv",
  "dx",
  "l",
  "list",
]);
const MUTATING_SQL_TOKENS = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "into",
  "create",
  "alter",
  "drop",
  "truncate",
  "copy",
  "grant",
  "revoke",
  "comment",
  "refresh",
  "reindex",
  "cluster",
  "vacuum",
  "analyze",
  "call",
  "do",
  "lock",
  "discard",
  "set",
  "reset",
  "begin",
  "start",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "prepare",
  "execute",
  "deallocate",
  "checkpoint",
  "listen",
  "unlisten",
  "notify",
]);

export interface SourceValues {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export interface InjectedValuesState {
  port: number;
  endpoint: string;
  logPath: string;
  source: SourceValues;
  requiresSsl: boolean;
}

export interface BuildInjectedValuesOptions {
  env?: NodeJS.ProcessEnv;
  pythonShimDir?: string;
  readEnv?: (envName: string) => string | undefined;
}

export function needsSsl(host: string): boolean {
  return !["localhost", "127.0.0.1", "::1"].includes(host);
}

export function deriveEndpoint(host: string): string {
  if (!needsSsl(host) || !host.includes(".")) return "";
  return host.split(".")[0] ?? "";
}

export function mergePathValue(prependValue: string, existingValue: string | undefined): string {
  if (!existingValue) return prependValue;
  return `${prependValue}${delimiter}${existingValue}`;
}

export function encodeConnectionUrl(
  scheme: string,
  source: SourceValues,
  port: number,
  sslValue: string | null,
  endpoint: string,
): string {
  const user = encodeURIComponent(source.user);
  const password = encodeURIComponent(source.password);
  const database = encodeURIComponent(source.database);
  const params = new URLSearchParams();
  if (sslValue) {
    if (sslValue === "require") params.set("sslmode", sslValue);
    else params.set("ssl", sslValue);
  }
  if (endpoint) params.set("options", `endpoint=${endpoint}`);
  const query = params.toString();
  return `${scheme}://${user}:${password}@127.0.0.1:${port}/${database}${query ? `?${query}` : ""}`;
}

export function buildInjectedValues(
  config: Pick<ResolvedConfig, "injectEnv" | "injectPythonShim" | "path">,
  state: InjectedValuesState,
  options: BuildInjectedValuesOptions = {},
): Record<string, string> {
  const env = options.env ?? process.env;
  const readEnv = options.readEnv ?? ((envName: string) => env[envName]);
  const source = state.source;
  const postgresUrl = encodeConnectionUrl(
    "postgresql",
    source,
    state.port,
    state.requiresSsl ? "require" : null,
    state.endpoint,
  );
  const sqlalchemyUrl = encodeConnectionUrl(
    "postgresql+psycopg2",
    source,
    state.port,
    state.requiresSsl ? "require" : null,
    state.endpoint,
  );
  const asyncpgDsn = encodeConnectionUrl(
    "postgresql",
    source,
    state.port,
    state.requiresSsl ? "require" : null,
    state.endpoint,
  ).replace("sslmode=require", "ssl=require");
  const sqlalchemyAsyncUrl = asyncpgDsn.replace("postgresql://", "postgresql+asyncpg://");

  const tokens: Record<string, string> = {
    postgres_url: postgresUrl,
    psql_url: postgresUrl,
    sqlalchemy_url: sqlalchemyUrl,
    sqlalchemy_async_url: sqlalchemyAsyncUrl,
    psycopg2_url: sqlalchemyUrl,
    asyncpg_dsn: asyncpgDsn,
    tunnel_host: "127.0.0.1",
    tunnel_port: String(state.port),
    endpoint: state.endpoint,
    pgoptions: state.endpoint ? `endpoint=${state.endpoint}` : "",
    sslmode: state.requiresSsl ? "require" : "disable",
    source_host: source.host,
    source_port: source.port,
    source_user: source.user,
    source_password: source.password,
    source_database: source.database,
    config_path: config.path,
    log_path: state.logPath,
    "1": "1",
  };

  const resolved: Record<string, string> = {};
  for (const [envName, spec] of Object.entries(config.injectEnv)) {
    if (spec.startsWith("source:")) {
      resolved[envName] = readEnv(spec.slice("source:".length)) ?? "";
      continue;
    }
    resolved[envName] = tokens[spec] ?? spec;
  }

  if (config.injectPythonShim && options.pythonShimDir) {
    resolved.PYTHONPATH = mergePathValue(
      options.pythonShimDir,
      resolved.PYTHONPATH ?? env.PYTHONPATH,
    );
  }

  return resolved;
}

function readDollarQuoteTag(sql: string, index: number): string | null {
  const match = /^(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/.exec(sql.slice(index));
  return match?.[0] ?? null;
}

function replacementChar(char: string): string {
  return char === "\n" || char === "\r" || char === "\t" ? char : " ";
}

function sanitizeSql(sql: string): string {
  let result = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (char === "-" && next === "-") {
      result += "  ";
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        result += replacementChar(sql[index] ?? " ");
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      result += "  ";
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        const current = sql[index] ?? "";
        const following = sql[index + 1] ?? "";
        if (current === "/" && following === "*") {
          depth += 1;
          result += "  ";
          index += 2;
          continue;
        }
        if (current === "*" && following === "/") {
          depth -= 1;
          result += "  ";
          index += 2;
          continue;
        }
        result += replacementChar(current);
        index += 1;
      }
      continue;
    }

    if (char === "'") {
      result += " ";
      index += 1;
      while (index < sql.length) {
        const current = sql[index] ?? "";
        result += replacementChar(current);
        index += 1;
        if (current === "'") {
          if (sql[index] === "'") {
            result += replacementChar(sql[index] ?? " ");
            index += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (char === '"') {
      result += " ";
      index += 1;
      while (index < sql.length) {
        const current = sql[index] ?? "";
        result += replacementChar(current);
        index += 1;
        if (current === '"') {
          if (sql[index] === '"') {
            result += replacementChar(sql[index] ?? " ");
            index += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (char === "$") {
      const tag = readDollarQuoteTag(sql, index);
      if (tag) {
        result += " ".repeat(tag.length);
        index += tag.length;
        while (index < sql.length && !sql.startsWith(tag, index)) {
          result += replacementChar(sql[index] ?? " ");
          index += 1;
        }
        if (sql.startsWith(tag, index)) {
          result += " ".repeat(tag.length);
          index += tag.length;
        }
        continue;
      }
    }

    result += char;
    index += 1;
  }

  return result;
}

function splitSqlStatements(sql: string): string[] {
  return sanitizeSql(sql)
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function findFirstTokenIndex(statement: string, tokens: readonly string[]): number {
  const lower = statement.toLowerCase();
  let bestIndex = -1;
  for (const token of tokens) {
    const pattern = new RegExp(`\\b${token}\\b`, "i");
    const match = pattern.exec(lower);
    if (!match) continue;
    if (bestIndex === -1 || match.index < bestIndex) {
      bestIndex = match.index;
    }
  }
  return bestIndex;
}

function stripExplainPrefix(statement: string): string | null {
  const remainder = statement.replace(/^explain\b/i, "").trimStart();
  if (!remainder) return null;

  if (remainder.startsWith("(")) {
    let depth = 0;
    let index = 0;
    while (index < remainder.length) {
      const char = remainder[index] ?? "";
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          return remainder.slice(index + 1).trimStart() || null;
        }
      }
      index += 1;
    }
    return null;
  }

  const nestedIndex = findFirstTokenIndex(remainder, [...READ_ONLY_LEAD_KEYWORDS, "explain"]);
  return nestedIndex >= 0 ? remainder.slice(nestedIndex).trimStart() : null;
}

function isAllowedPsqlInspectionCommand(statement: string): boolean {
  const trimmed = statement.trim();
  if (!trimmed.startsWith("\\")) return false;
  if (/[\r\n;]/.test(trimmed)) return false;

  const match = /^\\([A-Za-z]+)(\+?)([ \t].*)?$/.exec(trimmed);
  if (!match) return false;

  const command = match[1] ?? "";
  const args = match[3] ?? "";
  if (!SAFE_PSQL_INSPECTION_COMMANDS.has(command)) return false;
  return !args.includes("\\");
}

export function isReadOnlyQuery(query: string): boolean {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) return false;

  const statement = statements[0] ?? "";
  if (!statement) return false;
  if (statement.startsWith("\\")) return isAllowedPsqlInspectionCommand(statement);
  if (statement.includes("\\")) return false;

  const lower = statement.toLowerCase();
  const tokens = lower.match(/[a-z_][a-z0-9_$]*/g) ?? [];
  const lead = tokens[0];
  if (!lead) return false;

  if (lead === "explain") {
    const explained = stripExplainPrefix(statement);
    return explained ? isReadOnlyQuery(explained) : false;
  }

  if (!READ_ONLY_LEAD_KEYWORDS.has(lead)) return false;
  return !tokens.some((token) => MUTATING_SQL_TOKENS.has(token));
}
