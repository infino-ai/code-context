// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The hosted REST client: code-context's "hosted mode" talks to an Infino
// platform database over its `/v1/<op>/<database>` data plane instead of an
// in-process engine. This file owns the wire: request shapes (field names as
// the platform's request structs spell them), auth, the cold-start retry loop,
// error decoding, and the Arrow IPC encoding an append carries. Nothing here
// knows about chunks or tools - the callers keep the tool results identical to
// local mode and put the per-call telemetry (`HostedCallInfo`) in the usage
// ledger, never in what the model sees.

import * as arrow from "apache-arrow";

// --- constants ------------------------------------------------------------------

/** Per-call wall clock before a request is abandoned, when the caller sets
 * none: a cold read against a large table can take tens of seconds; a minute
 * leaves room without hiding a hung connection. Exported so the environment
 * layer (config.ts) resolves CX_DB_TIMEOUT_MS to this same value. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** How long the retry loop keeps re-issuing a retryable failure (a database
 * whose worker is still spawning answers 503 until it is up) before giving up.
 * The platform's own worker spawn is measured in tens of seconds, and a 529
 * (no capacity) hints a 600 s wait the budget refuses to take - two minutes
 * covers a spawn without stalling a session. Exported for config.ts likewise. */
export const DEFAULT_COLD_START_SECS = 120;

/** Seconds to wait before a retry when the server sent no `Retry-After`. The
 * platform's own activation hint is 5 s, so a missing header falls back to the
 * value the platform would have sent. */
const DEFAULT_RETRY_AFTER_SECS = 5;

/** Extra wall clock an `ask` gets on top of its own `max_wall_secs`: the loop
 * may run right up to its budget and the answer still has to travel back. */
const ASK_TIMEOUT_MARGIN_SECS = 60;

/** Milliseconds per second, named so the unit conversions read as such. */
const MS_PER_SEC = 1000;

/** The database's worker is still activating, or no capacity is free yet. */
const HTTP_SERVICE_UNAVAILABLE = 503;
/** The platform's own "no capacity to activate this database" status. */
const HTTP_OVERWHELMED = 529;
/** A write lost the single-writer race (retryable when it carries `Retry-After`)
 * or a name already exists (terminal, no `Retry-After`). */
const HTTP_CONFLICT = 409;
/** No card of the requested tier is stored for the table. */
const HTTP_NOT_FOUND = 404;

/** The API version prefix every route lives under. */
const API_PREFIX = "/v1";

/** Response and request encodings the platform negotiates on. */
const JSON_CONTENT_TYPE = "application/json";
const ARROW_STREAM_CONTENT_TYPE = "application/vnd.apache.arrow.stream";

/** The metering headers the gateway stamps on every response: decimal tokens
 * (`"0.050"`), one for reads and one for writes. */
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

/** The server's message out of an error body. The data plane answers in plain
 * text (worker bodies are proxied verbatim); the control plane (auth, table
 * cards) answers a JSON `{"error": "..."}`. Both are read, and anything else
 * comes back as the raw text. */
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

  /** `POST /v1/query_sql/{db}` with `{query}`: rows as a JSON array. */
  async querySql(sql: string): Promise<RowRecord[]> {
    return this.rows(await this.postJson("query_sql", { query: sql }, true), "query_sql");
  }

  async bm25Search(
    table: string,
    column: string,
    query: string,
    k: number,
    opts: { projection?: string[]; mode?: "or" | "and" } = {},
  ): Promise<RowRecord[]> {
    const body: RowRecord = {
      table_name: table,
      field_name: column,
      query,
      k,
      mode: opts.mode ?? "or",
      ...(opts.projection ? { projection: opts.projection } : {}),
    };
    return this.rows(await this.postJson("bm25_search", body, true), "bm25_search");
  }

  /** BM25 + vector fused with RRF. The vector leg takes the caller's own
   * vector (`vector_query`) or, for an embedding column, the text the platform
   * embeds (`vector_text`). */
  async hybridSearch(
    table: string,
    textColumn: string,
    query: string,
    vectorColumn: string,
    vector: number[] | { text: string },
    k: number,
    opts: { projection?: string[] } = {},
  ): Promise<RowRecord[]> {
    const body: RowRecord = {
      table_name: table,
      text_field: textColumn,
      text_query: query,
      mode: "or",
      vector_field: vectorColumn,
      ...(Array.isArray(vector) ? { vector_query: vector } : { vector_text: vector.text }),
      k,
      ...(opts.projection ? { projection: opts.projection } : {}),
    };
    return this.rows(await this.postJson("hybrid_search", body, true), "hybrid_search");
  }

  /** Unranked: every row whose indexed `column` holds the query's tokens. The
   * raw query string goes as-is; the platform tokenizes it with the index's
   * own analyzer, so no client-side pre-tokenizing is needed. */
  async tokenMatch(
    table: string,
    column: string,
    query: string,
    opts: { projection?: string[]; mode?: "or" | "and" } = {},
  ): Promise<RowRecord[]> {
    const body: RowRecord = {
      table_name: table,
      field_name: column,
      query,
      mode: opts.mode ?? "or",
      ...(opts.projection ? { projection: opts.projection } : {}),
    };
    return this.rows(await this.postJson("token_match", body, true), "token_match");
  }

  // --- ask / cards ---

  /** `POST /v1/ask/{db}`: the answering loop. The per-call timeout is the
   * request's own `max_wall_secs` plus a margin for the answer to travel; with
   * no `max_wall_secs` the deployment's cap applies server-side and the
   * client's general timeout is all it can go on. 503 (tables not carded yet /
   * cold database) is retried like any other op; 501 (no ask configured) is
   * terminal. */
  async ask(req: {
    question: string;
    answer?: "text" | "scalar" | "sql";
    max_turns?: number;
    max_wall_secs?: number;
    include_transcript?: boolean;
  }): Promise<RowRecord> {
    // Only the fields given are sent: the request type rejects unknown keys and
    // defaults the rest itself.
    const body: RowRecord = { question: req.question };
    if (req.answer !== undefined) body.answer = req.answer;
    if (req.max_turns !== undefined) body.max_turns = req.max_turns;
    if (req.max_wall_secs !== undefined) body.max_wall_secs = req.max_wall_secs;
    if (req.include_transcript !== undefined) body.include_transcript = req.include_transcript;
    const timeoutMs =
      req.max_wall_secs !== undefined ? (req.max_wall_secs + ASK_TIMEOUT_MARGIN_SECS) * MS_PER_SEC : this.timeoutMs;
    const exchange = await this.call({
      op: "ask",
      method: "POST",
      body: JSON.stringify(body),
      contentType: JSON_CONTENT_TYPE,
      acceptJson: true,
      timeoutMs,
    });
    return this.parseJson(exchange, "ask") as RowRecord;
  }

  /** `GET /v1/table_card/{db}?table=T[&tier=lean|enriched|semantic]`: the
   * optimizer's card for the table, or null while none of that tier is stored
   * yet (the platform's 404). */
  async tableCard(table: string, tier?: string): Promise<RowRecord | null> {
    try {
      const exchange = await this.call({
        op: "table_card",
        method: "GET",
        query: { table, ...(tier !== undefined ? { tier } : {}) },
        acceptJson: true,
        timeoutMs: this.timeoutMs,
      });
      return this.parseJson(exchange, "table_card") as RowRecord;
    } catch (err) {
      if (err instanceof HostedError && err.status === HTTP_NOT_FOUND) return null;
      throw err;
    }
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
