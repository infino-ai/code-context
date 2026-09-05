// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The platform REST client: code-context talks to an Infino platform database
// over its `/v1/<op>/<database>` data plane to keep the repository's chunks
// table there beside the local index (every build and sync writes both) and
// to run the `subagent` and `explore` tools against it. This file owns the
// wire: request shapes (field names as the platform's request structs spell
// them), auth, the cold-start retry loop, error decoding, and the Arrow IPC
// encoding an append carries. Nothing here knows about chunks or tools - the
// callers put the per-call telemetry (`HostedCallInfo`) in the usage ledger,
// never in what the model sees.

import * as arrow from "apache-arrow";

// --- constants ------------------------------------------------------------------

/** Per-call wall clock before a request is abandoned, when the caller sets
 * none: a cold read against a large table can take tens of seconds; a minute
 * leaves room without hiding a hung connection. Exported so the settings
 * layer (config.ts) gives --db-timeout-ms this same default. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** How long the retry loop keeps re-issuing a retryable "not ready yet"
 * answer before giving up. Two minutes covers a database coming up without
 * stalling a session; a `Retry-After` longer than the budget is refused rather
 * than waited out. Exported for config.ts likewise. */
export const DEFAULT_COLD_START_SECS = 120;

/** Seconds to wait before a retry when the server sent no `Retry-After`. */
const DEFAULT_RETRY_AFTER_SECS = 5;

/** Extra wall clock a `sub_agent` call gets on top of its own `max_wall_secs`:
 * the loop may run right up to its budget and the answer still has to travel
 * back. */
const ASK_TIMEOUT_MARGIN_SECS = 60;

/** Milliseconds per second, named so the unit conversions read as such. */
const MS_PER_SEC = 1000;

/** The database is not ready to answer yet; retryable. */
const HTTP_SERVICE_UNAVAILABLE = 503;
/** The platform is declining for now; retryable when it says when. */
const HTTP_OVERWHELMED = 529;
/** A write lost a race (retryable when it carries `Retry-After`) or a name
 * already exists (terminal, no `Retry-After`). */
const HTTP_CONFLICT = 409;

/** The API version prefix every route lives under. */
const API_PREFIX = "/v1";

/** Response and request encodings the platform negotiates on. */
const JSON_CONTENT_TYPE = "application/json";
const ARROW_STREAM_CONTENT_TYPE = "application/vnd.apache.arrow.stream";

/** The metering headers the platform returns on every response: decimal
 * tokens (`"0.050"`), one for reads and one for writes. */
const READ_TOKENS_HEADER = "x-infino-read-tokens";
const WRITE_TOKENS_HEADER = "x-infino-write-tokens";

/** The hosts a plaintext `http://` target may name: the request never leaves
 * the machine, so the bearer credential is never on the wire in the clear. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Every column type spelling the platform's `create_table` accepts, mapped to
 * the Arrow type an appended batch must carry for it. Mirrors the platform's
 * `data_type_from_str` so an IPC append matches the table the same descriptors
 * created. Text defaults to `large_utf8` on the platform side, so that is what a
 * code-context text column declares. */
const SCALAR_TYPES: Record<string, () => arrow.DataType> = {
  utf8: () => new arrow.Utf8(),
  string: () => new arrow.Utf8(),
  large_utf8: () => new arrow.LargeUtf8(),
  large_string: () => new arrow.LargeUtf8(),
  bool: () => new arrow.Bool(),
  boolean: () => new arrow.Bool(),
  i32: () => new arrow.Int32(),
  int32: () => new arrow.Int32(),
  i64: () => new arrow.Int64(),
  int64: () => new arrow.Int64(),
  u32: () => new arrow.Uint32(),
  uint32: () => new arrow.Uint32(),
  u64: () => new arrow.Uint64(),
  uint64: () => new arrow.Uint64(),
  f32: () => new arrow.Float32(),
  float32: () => new arrow.Float32(),
  f64: () => new arrow.Float64(),
  float64: () => new arrow.Float64(),
  double: () => new arrow.Float64(),
};

/** The 64-bit integer spellings, whose values are handed to Arrow as bigint. */
const INT64_TYPES = new Set(["i64", "int64", "u64", "uint64"]);

/** Arrow's IPC streaming format, as `tableToIPC` names it. */
const IPC_STREAM = "stream";

// --- public types ---------------------------------------------------------------

/** A hosted database: where it is, which database, and the key that opens it. */
export interface HostedTarget {
  baseUrl: string;
  database: string;
  apiKey: string;
}

/** What one logical call cost: the final status, the round trip of the
 * attempt that answered, how many retries the cold-start loop took, and the
 * tokens the platform billed (from its response headers, when present). */
export interface HostedCallInfo {
  op: string;
  status: number;
  rttMs: number;
  retries: number;
  readTokens?: number;
  writeTokens?: number;
}

export interface HostedOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-call timeout (default 60 s). An `ask` uses its own budget instead. */
  timeoutMs?: number;
  /** How long retryable failures are re-issued before giving up (default 120 s). */
  coldStartSecs?: number;
  /** Called once per logical call with its telemetry. */
  onCall?: (info: HostedCallInfo) => void;
}

export type RowRecord = Record<string, unknown>;

/** How the platform's loop answers a `sub_agent` request: `retrieve` returns
 * the first validating query's rows; `explore` reads and follows what it
 * finds and adds a written answer and the chain of queries. */
export type SubAgentMode = "retrieve" | "explore";

/** One column of a `create_table` schema, in code-context's shape. A scalar is
 * the platform's type spelling (`"large_utf8"`, `"i32"`, ...); a vector column
 * names its width; an embedding column names the text columns the platform
 * embeds for it (the caller never sends its values). */
export interface JsonColumn {
  name: string;
  type: string | { type: "vector"; dim: number } | { type: "embedding"; source: string[] };
  nullable?: boolean;
}

export interface HostedIndexes {
  fts: Array<{ column: string; analyzer?: string }>;
  vector?: Array<{ column: string; metric: "cosine" | "l2sq" | "negdot" }>;
}

/** A failure the platform reported (or a transport failure, `status` 0). The
 * message carries the op, the status, and the server's own words - never the
 * request headers, so a credential cannot leak through an error. */
export class HostedError extends Error {
  readonly status: number;
  readonly op: string;
  /** The server's `Retry-After`, in seconds, when the failure carried one. */
  readonly retryAfterSecs?: number;

  constructor(op: string, status: number, message: string, options?: { retryAfterSecs?: number; cause?: unknown }) {
    super(status > 0 ? `${op}: server returned ${status}: ${message}` : `${op}: ${message}`, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HostedError";
    this.op = op;
    this.status = status;
    if (options?.retryAfterSecs !== undefined) this.retryAfterSecs = options.retryAfterSecs;
  }
}

// --- URLs -----------------------------------------------------------------------

/** Whether `s` names a hosted target (an `http(s)://` URL) rather than a local
 * path or object-store URI. */
export function isHostedUrl(s: string): boolean {
  return /^https?:\/\//.test(s);
}

/** Split `https://host/db` into the base URL and the database segment. Mirrors
 * the engine's own URI rule: `http://` is refused for anything but a loopback
 * host (a bearer credential must not travel in the clear), the database segment
 * is required, and it must be a single path segment - the routes are
 * `/v1/<op>/<database>`, so a nested path could not address anything. */
export function parseHostedUrl(url: string): { baseUrl: string; database: string } {
  const match = /^(https?):\/\/([^/?#]*)(.*)$/.exec(url);
  if (!match) {
    throw new Error(`hosted URL must start with https:// (or http:// for a loopback host): ${url}`);
  }
  const [, scheme, host, rest] = match;
  if (host.length === 0) throw new Error(`hosted URL is missing a host: ${url}`);
  if (scheme === "http") {
    const bare = host.split(":")[0];
    if (!LOOPBACK_HOSTS.has(bare)) {
      throw new Error(`http:// is only allowed for localhost; use https:// for a remote host: ${url}`);
    }
  }
  if (/[?#]/.test(rest)) throw new Error(`hosted URL must not carry a query or fragment: ${url}`);
  const database = rest.replace(/^\/+|\/+$/g, "");
  if (database.length === 0) {
    throw new Error(`hosted URL is missing the database segment (expected https://host/<database>): ${url}`);
  }
  if (database.includes("/")) {
    throw new Error(`hosted URL database must be a single path segment, got "${database}": ${url}`);
  }
  return { baseUrl: `${scheme}://${host}`, database };
}

// --- headers --------------------------------------------------------------------

/** The wait a `Retry-After` header asks for, in milliseconds: delta-seconds or
 * an HTTP-date, with the platform's activation hint standing in when the header
 * is absent or unreadable. Never negative - a date already past means "now". */
export function retryAfterMs(value: string | null): number {
  if (value !== null) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * MS_PER_SEC;
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return DEFAULT_RETRY_AFTER_SECS * MS_PER_SEC;
}

/** A decimal token header (`"0.050"`) as a number, or undefined when absent
 * or not numeric - a missing meter is not a zero bill. */
function tokensHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The server's message out of an error body: plain text, or a JSON
 * `{"error": "..."}`. Both are read, and anything else comes back as the raw
 * text. */
export function serverMessage(status: number, body: string): string {
  const text = body.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.message === "string") return parsed.message;
    } catch {
      // not JSON after all - fall through to the raw text
    }
  }
  return text.length > 0 ? text : `HTTP ${status}`;
}

// --- the client -------------------------------------------------------------------

/** One HTTP exchange's outcome, before the op-specific decoding. */
interface Exchange {
  status: number;
  headers: Headers;
  text: string;
}

interface CallSpec {
  op: string;
  method: "GET" | "POST";
  /** Query-string parameters, appended after the database segment. */
  query?: Record<string, string>;
  body?: string | Uint8Array;
  contentType?: string;
  /** Whether the response is rows/JSON we want as JSON rather than Arrow. */
  acceptJson: boolean;
  timeoutMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class HostedDb {
  readonly target: HostedTarget;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly coldStartMs: number;
  private readonly onCall?: (info: HostedCallInfo) => void;
  private last: HostedCallInfo | null = null;

  constructor(target: HostedTarget, opts: HostedOptions = {}) {
    if (!target.apiKey) {
      // Every route is bearer-only; failing here names the problem instead of
      // letting the first call come back as an opaque 401.
      throw new Error("hosted target needs an API key (apiKey / INFINO_API_KEY)");
    }
    this.target = { ...target, baseUrl: target.baseUrl.replace(/\/+$/, "") };
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.coldStartMs = (opts.coldStartSecs ?? DEFAULT_COLD_START_SECS) * MS_PER_SEC;
    this.onCall = opts.onCall;
  }

  /** Telemetry of the most recent logical call, or null before the first. */
  lastCall(): HostedCallInfo | null {
    return this.last;
  }

  // --- tables ---

  /** `POST /v1/list_tables/{db}`: the database's table names. */
  async listTables(): Promise<string[]> {
    const exchange = await this.call({ op: "list_tables", method: "POST", acceptJson: true, timeoutMs: this.timeoutMs });
    return this.parseJson(exchange, "list_tables") as string[];
  }

  /** `POST /v1/schema/{db}` with `{table_name}`: the platform's JSON column
   * descriptors (`[{name, type, nullable, ...}]`), parsed as they came. */
  async schema(table: string): Promise<RowRecord> {
    const exchange = await this.postJson("schema", { table_name: table }, true);
    return this.parseJson(exchange, "schema") as RowRecord;
  }

  /** `POST /v1/create_table/{db}`: `{table_name, schema, indexes}`. A bare
   * `{column}` fts entry takes the platform's default analyzer (`standard`). */
  async createTable(table: string, columns: JsonColumn[], indexes: HostedIndexes): Promise<void> {
    const body: RowRecord = {
      table_name: table,
      schema: columns.map(toSchemaField),
      indexes: {
        fts: indexes.fts.map((f) => (f.analyzer === undefined ? { column: f.column } : { column: f.column, analyzer: f.analyzer })),
        ...(indexes.vector ? { vector: indexes.vector.map((v) => ({ column: v.column, metric: v.metric })) } : {}),
      },
    };
    await this.postJson("create_table", body, false);
  }

  /** `POST /v1/drop_table/{db}`: `{table_name, purge}`. The platform defaults
   * purge to true; it is sent explicitly so the request says what it does. */
  async dropTable(table: string, purge = true): Promise<void> {
    await this.postJson("drop_table", { table_name: table, purge }, false);
  }

  // --- writes ---

  /** `POST /v1/append/{db}?table=T` with an Arrow IPC stream body - the only
   * append encoding that can carry a vector column. */
  async appendIpc(table: string, ipc: Uint8Array): Promise<void> {
    await this.call({
      op: "append",
      method: "POST",
      query: { table },
      body: ipc,
      contentType: ARROW_STREAM_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
  }

  /** `POST /v1/append/{db}?table=T` with the JSON `{"data": [...]}` envelope.
   * Rows are decoded server-side against the table's schema; a vector column
   * cannot ride this path (use `appendIpc`). */
  async appendRows(table: string, rows: RowRecord[]): Promise<void> {
    await this.call({
      op: "append",
      method: "POST",
      query: { table },
      body: JSON.stringify({ data: rows }),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
  }

  /** `POST /v1/delete/{db}?table=T&predicate=P` (no body): the mutation's
   * `{matched, n_tombstoned, n_not_found}`. */
  async deleteWhere(table: string, predicate: string): Promise<RowRecord> {
    const exchange = await this.call({
      op: "delete",
      method: "POST",
      query: { table, predicate },
      acceptJson: true,
      timeoutMs: this.timeoutMs,
    });
    return this.parseJson(exchange, "delete") as RowRecord;
  }

  // --- reads ---

  /** `POST /v1/query_sql/{db}` with `{query}`: rows as a JSON array. The one
   * read the client makes outside `sub_agent` - a sync's recount of the
   * table. The search routes (bm25, hybrid, token_match, find) are the
   * platform's own loop's to call; `find`, `search` and `sql` read the local
   * index. */
  async querySql(sql: string): Promise<RowRecord[]> {
    return this.rows(await this.postJson("query_sql", { query: sql }, true), "query_sql");
  }

  // --- sub_agent ---

  /** `POST /v1/sub_agent/{db}`: the platform's retrieval loop. It answers
   * with facts - `facts`, the first `k` rows of the query that validated,
   * each `{table?, row}`; `statement`, that query verbatim; `coverage`, how
   * many rows the query returned against how many are in `facts` - and the
   * loop's accounting (`turns`, `retries`, and `model_tokens`, the one number
   * the platform meters the call on; its costs are otherwise its own); never
   * anything the model wrote. A loop that found no
   * query still answers 200 with `terminate` saying how (`escalated` carries
   * the model's account of the problem in `error`). The per-call timeout is
   * the request's own `max_wall_secs` plus a margin for the answer to
   * travel; with no `max_wall_secs` the server's cap applies and the
   * client's general timeout is all it can go on. A retryable 503 is retried
   * like any other op; 501 (no agent configured) is terminal. In `explore`
   * mode the response adds `answer` (the model's written answer) and `chain`
   * (every query that returned rows, in order). */
  async subAgent(req: {
    question: string;
    /** `retrieve` (the default when absent): the first validating query's rows.
     * `explore`: the loop reads what it finds and queries again, and answers
     * in writing beside the facts and the chain of queries. */
    mode?: SubAgentMode;
    k?: number;
    /** Columns a search or find fact carries beside its text and score, in
     * place of the table's keys - for a code table, the ones that place it. */
    projection?: string[];
    max_turns?: number;
    max_wall_secs?: number;
    include_transcript?: boolean;
  }): Promise<RowRecord> {
    // Only the fields given are sent: the request type rejects unknown keys and
    // defaults the rest itself.
    const body: RowRecord = { question: req.question };
    if (req.mode !== undefined) body.mode = req.mode;
    if (req.k !== undefined) body.k = req.k;
    if (req.projection !== undefined) body.projection = req.projection;
    if (req.max_turns !== undefined) body.max_turns = req.max_turns;
    if (req.max_wall_secs !== undefined) body.max_wall_secs = req.max_wall_secs;
    if (req.include_transcript !== undefined) body.include_transcript = req.include_transcript;
    const timeoutMs =
      req.max_wall_secs !== undefined ? (req.max_wall_secs + ASK_TIMEOUT_MARGIN_SECS) * MS_PER_SEC : this.timeoutMs;
    const exchange = await this.call({
      op: "sub_agent",
      method: "POST",
      body: JSON.stringify(body),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs,
    });
    return this.parseJson(exchange, "sub_agent") as RowRecord;
  }

  // --- plumbing ---

  private postJson(op: string, body: RowRecord, acceptJson: boolean): Promise<Exchange> {
    return this.call({
      op,
      method: "POST",
      body: JSON.stringify(body),
      contentType: JSON_CONTENT_TYPE,
      acceptJson,
      timeoutMs: this.timeoutMs,
    });
  }

  /** A read response as rows. The platform answers Arrow unless asked for JSON,
   * so a body that came back as Arrow means the negotiation failed - said so,
   * rather than handed to JSON.parse. An empty body is an empty result. */
  private rows(exchange: Exchange, op: string): RowRecord[] {
    const contentType = exchange.headers.get("content-type") ?? "";
    if (contentType.includes(ARROW_STREAM_CONTENT_TYPE)) {
      throw new HostedError(op, exchange.status, "expected JSON rows but the server answered an Arrow stream");
    }
    if (exchange.text.trim().length === 0) return [];
    return this.parseJson(exchange, op) as RowRecord[];
  }

  private parseJson(exchange: Exchange, op: string): unknown {
    if (exchange.text.trim().length === 0) return null;
    try {
      return JSON.parse(exchange.text);
    } catch (err) {
      throw new HostedError(op, exchange.status, `response is not JSON: ${(err as Error).message}`);
    }
  }

  private url(op: string, query?: Record<string, string>): string {
    let url = `${this.target.baseUrl}${API_PREFIX}/${op}/${encodeURIComponent(this.target.database)}`;
    if (query) url += `?${new URLSearchParams(query).toString()}`;
    return url;
  }

  /** One logical call: issue the request, re-issue it while the platform says
   * "not yet" (503 / 529, and a 409 that carries `Retry-After` - a write that
   * lost the single-writer race; a 409 without one is a name collision and
   * terminal) until the cold-start budget is spent, then record the telemetry
   * and either return the exchange or throw the server's error. */
  private async call(spec: CallSpec): Promise<Exchange> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.target.apiKey}` };
    if (spec.acceptJson) headers.accept = JSON_CONTENT_TYPE;
    if (spec.contentType) headers["content-type"] = spec.contentType;
    const url = this.url(spec.op, spec.query);
    const deadline = Date.now() + this.coldStartMs;
    let retries = 0;

    for (;;) {
      const t0 = performance.now();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: spec.method,
          headers,
          // fetch takes a Uint8Array body; the DOM typing only spells it as
          // BodyInit, hence the cast.
          ...(spec.body !== undefined ? { body: spec.body as BodyInit } : {}),
          signal: AbortSignal.timeout(spec.timeoutMs),
        });
      } catch (err) {
        const rttMs = performance.now() - t0;
        this.record({ op: spec.op, status: 0, rttMs, retries });
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw new HostedError(
          spec.op,
          0,
          timedOut ? `no response within ${spec.timeoutMs} ms` : `request failed: ${(err as Error).message}`,
          { cause: err },
        );
      }
      const text = await response.text();
      const rttMs = performance.now() - t0;
      const info: HostedCallInfo = { op: spec.op, status: response.status, rttMs, retries };
      const readTokens = tokensHeader(response.headers, READ_TOKENS_HEADER);
      const writeTokens = tokensHeader(response.headers, WRITE_TOKENS_HEADER);
      if (readTokens !== undefined) info.readTokens = readTokens;
      if (writeTokens !== undefined) info.writeTokens = writeTokens;

      if (response.ok) {
        this.record(info);
        return { status: response.status, headers: response.headers, text };
      }

      const retryAfter = response.headers.get("retry-after");
      const retryable =
        response.status === HTTP_SERVICE_UNAVAILABLE ||
        response.status === HTTP_OVERWHELMED ||
        (response.status === HTTP_CONFLICT && retryAfter !== null);
      if (retryable) {
        const waitMs = retryAfterMs(retryAfter);
        // A wait that would outlive the budget is not taken: the caller learns
        // now that the database is not coming up in time.
        if (Date.now() + waitMs <= deadline) {
          retries++;
          await sleep(waitMs);
          continue;
        }
      }

      this.record(info);
      const message = serverMessage(response.status, text);
      const gaveUp = retryable ? ` (gave up after ${retries} retr${retries === 1 ? "y" : "ies"} within the ${this.coldStartMs / MS_PER_SEC} s cold-start budget)` : "";
      throw new HostedError(spec.op, response.status, `${message}${gaveUp}`, {
        ...(retryAfter !== null ? { retryAfterSecs: retryAfterMs(retryAfter) / MS_PER_SEC } : {}),
      });
    }
  }

  private record(info: HostedCallInfo): void {
    this.last = info;
    this.onCall?.(info);
  }
}

// --- schema and Arrow IPC ------------------------------------------------------------

/** One `create_table` column as the platform's `SchemaField` spells it. An
 * embedding column carries no `nullable`: the platform fills every row, and
 * declares such a column never nullable itself. */
function toSchemaField(column: JsonColumn): RowRecord {
  const nullable = column.nullable === undefined ? {} : { nullable: column.nullable };
  if (typeof column.type === "string") return { name: column.name, type: column.type, ...nullable };
  if (column.type.type === "vector") return { name: column.name, type: "vector", dim: column.type.dim, ...nullable };
  return { name: column.name, type: "embedding", source: column.type.source };
}

/** The Arrow field an appended batch must carry for `column`. Nullability
 * defaults to true exactly as the platform's `create_table` defaults it: the
 * engine compares an appended batch's fields to the table's by type AND
 * nullability, so the two defaults have to agree. */
function toArrowField(column: JsonColumn): arrow.Field {
  const nullable = column.nullable ?? true;
  if (typeof column.type === "string") {
    const make = SCALAR_TYPES[column.type];
    if (!make) throw new Error(`rowsToIpc: unsupported column type ${JSON.stringify(column.type)} for "${column.name}"`);
    return new arrow.Field(column.name, make(), nullable);
  }
  if (column.type.type === "vector") {
    const item = new arrow.Field("item", new arrow.Float32(), true);
    return new arrow.Field(column.name, new arrow.FixedSizeList(column.type.dim, item), nullable);
  }
  throw new Error(`rowsToIpc: embedding column "${column.name}" is filled by the platform and is never sent`);
}

/** Build one typed column. Scalars go through Arrow's builder from the row
 * values (an omitted key is a null, not the type's zero); a vector column is a
 * FixedSizeList over one flat Float32 buffer, built by hand because the builder
 * path does not take nested data. Every row must carry a full-width vector - a
 * short one would make a silently wrong index, the one unrecoverable outcome. */
function buildColumn(field: arrow.Field, column: JsonColumn, rows: RowRecord[]): arrow.Vector {
  const values = rows.map((r) => r[column.name] ?? null);
  if (typeof column.type !== "string") {
    const dim = (column.type as { dim: number }).dim;
    const flat = new Float32Array(rows.length * dim);
    values.forEach((v, i) => {
      if (!Array.isArray(v) && !(v instanceof Float32Array)) {
        throw new Error(`rowsToIpc: row ${i} has no vector for "${column.name}"`);
      }
      if (v.length !== dim) {
        throw new Error(`rowsToIpc: row ${i} vector for "${column.name}" has ${v.length} values, expected ${dim}`);
      }
      flat.set(v as ArrayLike<number>, i * dim);
    });
    const listType = field.type as arrow.FixedSizeList;
    const child = arrow.makeData({ type: listType.children[0].type as arrow.Float32, length: flat.length, data: flat });
    const data = arrow.makeData({ type: listType, length: rows.length, nullCount: 0, child });
    return arrow.makeVector(data);
  }
  const typed = INT64_TYPES.has(column.type) ? values.map((v) => (v == null ? null : BigInt(v as number | bigint))) : values;
  return arrow.vectorFromArray(typed, field.type);
}

/** Rows as an Arrow IPC stream carrying one record batch whose schema is the
 * table's: text as `large_utf8`, line numbers as `int32`, a vector column as
 * `FixedSizeList<Float32, dim>`. Embedding columns are left out - the platform
 * fills them and rejects a batch that sends them. */
export function rowsToIpc(columns: JsonColumn[], rows: RowRecord[]): Uint8Array {
  const sent = columns.filter((c) => typeof c.type === "string" || c.type.type !== "embedding");
  const fields = sent.map(toArrowField);
  const schema = new arrow.Schema(fields);
  // The batch is assembled by hand around the declared schema. Handing the
  // columns to `new Table(schema, columns)` would let Arrow re-derive the
  // schema from the vectors when a batch is empty (every field nullable), and
  // the declared nullability is exactly what the engine checks on append.
  const children = sent.map((c, i) => {
    const vector = buildColumn(fields[i], c, rows);
    if (vector.data.length !== 1) {
      throw new Error(`rowsToIpc: column "${c.name}" built as ${vector.data.length} chunks, expected one`);
    }
    return vector.data[0];
  });
  const structData = arrow.makeData({ type: new arrow.Struct(fields), length: rows.length, nullCount: 0, children });
  const table = new arrow.Table(schema, new arrow.RecordBatch(schema, structData));
  return arrow.tableToIPC(table, IPC_STREAM);
}
