export type SqlValue = string | number | null;
export type SqlStatement = { sql: string; args?: SqlValue[] };
export type SqlResult<T> = { rows: T[]; changes: number };
export interface SqlDatabase {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, args?: SqlValue[]): Promise<T[]>;
  execute(sql: string, args?: SqlValue[]): Promise<SqlResult<Record<string, unknown>>>;
  batch(statements: SqlStatement[]): Promise<SqlResult<Record<string, unknown>>[]>;
}

export class SqlStorageError extends Error {
  constructor(message = 'SQL storage operation failed') {
    super(message);
    this.name = 'SqlStorageError';
  }
}

export interface D1Result {
  success: boolean;
  results?: Record<string, unknown>[];
  meta?: { changes?: number };
}
export interface D1Statement {
  bind(...args: SqlValue[]): D1Statement;
  all(): Promise<D1Result>;
  run(): Promise<D1Result>;
}
export interface D1Binding {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
}

function validateArgs(args: SqlValue[]): void {
  if (args.some((value) => value !== null && typeof value !== 'string' &&
    (typeof value !== 'number' || !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))) {
    throw new SqlStorageError('Invalid SQL parameter');
  }
}

function d1Result(result: D1Result): SqlResult<Record<string, unknown>> {
  if (result.success !== true || !Array.isArray(result.results ?? [])) throw new SqlStorageError();
  const changes = result.meta?.changes ?? 0;
  if (!Number.isSafeInteger(changes) || changes < 0) throw new SqlStorageError('Invalid SQL response');
  return { rows: result.results ?? [], changes };
}

export function createD1Database(binding: D1Binding): SqlDatabase {
  const prepare = (sql: string, args: SqlValue[] = []) => {
    validateArgs(args);
    return binding.prepare(sql).bind(...args);
  };
  return {
    async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []): Promise<T[]> {
      try {
        return d1Result(await prepare(sql, args).all()).rows as T[];
      } catch {
        throw new SqlStorageError();
      }
    },
    async execute(sql, args = []) {
      try {
        return d1Result(await prepare(sql, args).all());
      } catch {
        throw new SqlStorageError();
      }
    },
    async batch(statements) {
      if (statements.length === 0) return [];
      try {
        const results = await binding.batch(statements.map(({ sql, args }) => prepare(sql, args)));
        if (results.length !== statements.length) throw new SqlStorageError();
        return results.map(d1Result);
      } catch {
        throw new SqlStorageError();
      }
    },
  };
}

type WireValue = { type: string; value?: unknown };
type WireStatement = { sql: string; args: WireValue[]; want_rows: boolean };
type BatchStep = { stmt: WireStatement; condition?: unknown };
function wireStatement(sql: string, args: SqlValue[] = []): WireStatement {
  validateArgs(args);
  return {
    sql,
    args: args.map((value) => value === null ? { type: 'null' } : typeof value === 'string'
      ? { type: 'text', value } : Number.isInteger(value)
        ? { type: 'integer', value: String(value) } : { type: 'float', value }),
    want_rows: true,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SqlStorageError('Invalid SQL response');
  return value as Record<string, unknown>;
}
function decodeValue(value: unknown): SqlValue {
  const cell = record(value);
  switch (cell.type) {
    case 'null': return null;
    case 'text':
      if (typeof cell.value === 'string') return cell.value;
      break;
    case 'integer':
      if (typeof cell.value === 'string' && /^-?\d+$/.test(cell.value)) {
        const result = Number(cell.value);
        if (Number.isSafeInteger(result)) return result;
      }
      break;
    case 'float':
      if (typeof cell.value === 'number' && Number.isFinite(cell.value)) return cell.value;
      break;
  }
  throw new SqlStorageError('Unsupported SQL value');
}
function decodeResult(value: unknown): SqlResult<Record<string, unknown>> {
  const result = record(value);
  if (!Array.isArray(result.cols) || !Array.isArray(result.rows)) throw new SqlStorageError('Invalid SQL response');
  const names = result.cols.map((column: unknown) => {
    const name = record(column).name;
    if (typeof name !== 'string') throw new SqlStorageError('Invalid SQL response');
    return name;
  });
  if (new Set(names).size !== names.length) throw new SqlStorageError('Ambiguous SQL columns');
  const rows = result.rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== names.length) throw new SqlStorageError('Invalid SQL response');
    return Object.fromEntries(names.map((name, index) => [name, decodeValue(row[index])]));
  });
  const changes = result.affected_row_count;
  if (typeof changes !== 'number' || !Number.isSafeInteger(changes) || changes < 0) throw new SqlStorageError('Invalid SQL response');
  return { rows, changes };
}

export function createTursoDatabase(options: { url: string; token: string; fetch?: typeof fetch; timeoutMs?: number }): SqlDatabase {
  let endpoint: URL;
  try {
    endpoint = new URL(options.url.replace(/^libsql:/, 'https:'));
  } catch {
    throw new SqlStorageError('Invalid Turso configuration');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !options.token.trim()) {
    throw new SqlStorageError('Invalid Turso configuration');
  }
  endpoint.pathname = '/v2/pipeline';
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new SqlStorageError('Invalid Turso timeout');
  async function pipeline(request: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
        body: JSON.stringify({ requests: [request, { type: 'close' }] }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new SqlStorageError();
      const body = record(await response.json());
      if (!Array.isArray(body.results) || body.results.length !== 2) throw new SqlStorageError();
      const item = record(body.results[0]);
      const close = record(body.results[1]);
      if (item.type !== 'ok' || close.type !== 'ok') throw new SqlStorageError();
      return record(item.response);
    } catch {
      throw new SqlStorageError();
    } finally {
      clearTimeout(timeout);
    }
  }
  async function execute(sql: string, args: SqlValue[] = []): Promise<SqlResult<Record<string, unknown>>> {
    const response = await pipeline({ type: 'execute', stmt: wireStatement(sql, args) });
    if (response.type !== 'execute') throw new SqlStorageError();
    return decodeResult(response.result);
  }
  return {
    async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []): Promise<T[]> {
      return (await execute(sql, args)).rows as T[];
    },
    execute,
    async batch(statements) {
      if (statements.length === 0) return [];
      const steps: BatchStep[] = [{ stmt: wireStatement('BEGIN IMMEDIATE') }];
      statements.forEach(({ sql, args }, index) => steps.push({
        stmt: wireStatement(sql, args), condition: { type: 'ok', step: index },
      }));
      const commitStep = steps.length;
      steps.push({ stmt: wireStatement('COMMIT'), condition: { type: 'ok', step: commitStep - 1 } });
      steps.push({ stmt: wireStatement('ROLLBACK'), condition: { type: 'not', cond: { type: 'ok', step: commitStep } } });
      const response = await pipeline({ type: 'batch', batch: { steps } });
      if (response.type !== 'batch') throw new SqlStorageError();
      const result = record(response.result);
      if (!Array.isArray(result.step_results) || result.step_results.length !== steps.length ||
        !Array.isArray(result.step_errors) || result.step_errors.length !== steps.length ||
        result.step_errors.some((error) => error !== null) || result.step_results[commitStep] === null) {
        throw new SqlStorageError();
      }
      return result.step_results.slice(1, commitStep).map(decodeResult);
    },
  };
}
