// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The shape of the hosted table the three doors read when `search` reads the
// hosted index (CX_REMOTE_SEARCH): which columns it has, which of them carry
// a text index, which one the platform embeds, and which one names a row.
//
// The doors were written for one table - the chunks table this client
// builds, whose columns are constants (path, start_line, end_line, content,
// embedding). Pointed at a table something else loaded (CX_TABLE naming a
// hydrated corpus), those constants are wrong: a hybrid search asking for
// `embedding` on a table whose vector column is `emb` is a 400, and a find
// over `content` has no such column to match in. So the shape comes from the
// table itself: its schema (POST /v1/schema, the platform's JSON column
// descriptors) and, once the optimizer has written one, its card, whose
// per-column index role says which columns are searchable rather than
// leaving that to be inferred from the types. A chunks-shaped table keeps
// every constant and every code path the doors had, byte for byte; what is
// here is for the other kind.

import type { HostedDb, RowRecord } from "./hosted.js";
import { CONTENT_COLUMN } from "./context.js";

/** One column as `POST /v1/schema` describes it: a scalar type spelling
 * (`utf8`, `large_utf8`, `f64`, ...) or `vector` / `list` / `embedding` with
 * the field that qualifies it. */
export interface SchemaField {
  name: string;
  type: string;
  nullable?: boolean;
  /** `type: "list"`: the element type. */
  item?: string;
  /** `type: "vector"`: the width. */
  dim?: number;
  /** `type: "embedding"`: the text columns the platform embeds, in order. */
  source?: string[];
}

/** One column of a table card's `schema`, the part the shape reads: the
 * index role the optimizer assigned it. */
export interface CardColumn {
  name: string;
  index?: string;
}

/** One column of the table as the tool text names it. */
export interface TableColumn {
  name: string;
  /** The type as shown to the model: the platform's spelling for a scalar,
   * `list<item>` for a list, `vector<dim>` for a client-filled vector,
   * `embedding` for the column the platform fills. */
  type: string;
}

export interface TableShape {
  table: string;
  /** Every column in schema order, the embedding column included. */
  columns: TableColumn[];
  /** The column the platform embeds and can embed a query for, or null when
   * the table has none. From the schema's type, not the card's role: a card
   * marks a client-filled vector column `vector` too, and a query can only
   * be sent as text against a column the platform embeds itself. */
  vectorColumn: string | null;
  /** What the embedding column embeds, from the schema; empty without one. */
  vectorSource: string[];
  /** The columns carrying a full-text index: the card's `fts` roles when a
   * card names any, else the LargeUtf8 columns - hydrate casts exactly the
   * indexed and embedded text columns to LargeUtf8 and leaves the rest Utf8,
   * so for a table with no card yet the type is the role. */
  textColumns: string[];
  /** True when no card named a full-text role and the LargeUtf8 types stood
   * in for one. An inferred list can name a column the platform embeds but
   * does not index (hydrate casts both kinds to LargeUtf8), so the tool text
   * says the list is inferred rather than stating it as the table's. */
  textColumnsInferred: boolean;
  /** The text column the doors search by default - one of `textColumns`
   * whenever there is one, since a search or token match over a column with
   * no full-text index is refused by the engine; "" when the table has no
   * text column at all. */
  primaryText: string;
  /** The columns a filter or GROUP BY reads as on any table: neither text,
   * nor list, nor vector. The tool text writes its examples with these. */
  scalarColumns: string[];
  /** The list columns - several values per row, filtered with array
   * functions rather than equality; the tool text says so when there are any. */
  listColumns: string[];
  /** The column that names a row: the card's `key` role, else the first
   * `id` / `*_id` column, else the engine's own `_id`. */
  keyColumn: string;
  /** Whether the table is the chunks table this client builds - path,
   * start_line, end_line and content. Such a table takes the constants and
   * code paths the doors always had. */
  isChunks: boolean;
  /** The row as a hit carries it: every column but the vector ones, with
   * `_id` first when nothing in the table keys a row. What a find selects -
   * a token match has no rank, so no `score` is asked for beyond a column
   * of the table's own that happens to bear the name. */
  rowColumns: string[];
  /** What a search asks the platform for: `rowColumns` and `score`, which
   * the platform returns only when it is named - once, whether or not the
   * table has a column called that. */
  projection: string[];
  /** The lean card as the platform served it, when the table has one - read
   * here for its roles and kept so the tool text can fold it in without a
   * second fetch. Absent for a table the optimizer has not swept yet. */
  card?: RowRecord;
}

/** The platform's type spellings for the three non-scalar column kinds. */
const EMBEDDING_TYPE = "embedding";
const VECTOR_TYPE = "vector";
const LIST_TYPE = "list";

/** The text spellings hydrate gives the columns it indexes and embeds. */
const LARGE_TEXT_TYPES = new Set(["large_utf8", "large_string"]);

/** Every text spelling, for the fallback when no column is LargeUtf8. */
const TEXT_TYPES = new Set(["utf8", "string", ...LARGE_TEXT_TYPES]);

/** The card's index roles this shape reads (the platform's vocabulary). */
const ROLE_FTS = "fts";
const ROLE_KEY = "key";

/** The engine's own row id, present on every table and returned by every
 * search function; the key of last resort. */
export const ENGINE_ID_COLUMN = "_id";

/** The column a search hit's rank travels in; returned only when asked for. */
export const SCORE_COLUMN = "score";

/** The columns that make a table the chunks table this client builds. */
const CHUNK_COLUMNS = ["path", "start_line", "end_line", CONTENT_COLUMN];

/** A text column whose name says it holds the text: preferred as the column
 * the doors search when a table has several. */
const TEXT_NAME_HINT = /content|body|description|text|abstract|summary/i;

/** A column whose name says it identifies the row. */
const KEY_NAME = /^(id|_id|.+_id)$/i;

/** One column's type as the tool text shows it. */
function renderType(field: SchemaField): string {
  if (field.type === LIST_TYPE) return `list<${field.item ?? "?"}>`;
  if (field.type === VECTOR_TYPE) return `vector<${field.dim ?? "?"}>`;
  return field.type;
}

/** The shape of `table` from its schema descriptors and, when it has one,
 * its card. Pure, so a test can hand it any table. */
export function tableShapeFrom(table: string, fields: SchemaField[], card?: RowRecord | null): TableShape {
  const cardColumns = Array.isArray(card?.schema) ? (card.schema as CardColumn[]).filter((c) => typeof c?.name === "string") : [];
  const roles = new Map(cardColumns.map((c) => [c.name, c.index]));
  const names = new Set(fields.map((f) => f.name));

  const embedding = fields.find((f) => f.type === EMBEDDING_TYPE);
  const vectorColumn = embedding?.name ?? null;
  const vectorSource = embedding?.source ?? [];

  // The card's roles are the truth when there is a card: the optimizer probed
  // every text column for an index, so a card that names no fts column
  // describes a table with none, and the doors must say so rather than search
  // a column the engine will refuse. Only with NO card are the types read -
  // hydrate casts exactly the columns it indexes or embeds to LargeUtf8 - and
  // only then may a plain text column stand in as a last resort.
  const hasCard = cardColumns.length > 0;
  const cardText = fields.filter((f) => roles.get(f.name) === ROLE_FTS).map((f) => f.name);
  const typedText = fields.filter((f) => LARGE_TEXT_TYPES.has(f.type)).map((f) => f.name);
  const textColumnsInferred = !hasCard;
  const textColumns = hasCard ? cardText : typedText;
  const anyText = hasCard ? [] : fields.filter((f) => TEXT_TYPES.has(f.type)).map((f) => f.name);
  // The embedding's source is preferred only when it is itself indexed: a
  // table can embed a column it does not index (the jobs table embeds
  // `title` and indexes `description_html`), and a search sent against the
  // unindexed one is refused by the engine.
  const primaryText =
    textColumns.find((name) => TEXT_NAME_HINT.test(name)) ??
    vectorSource.find((name) => textColumns.includes(name)) ??
    textColumns[0] ??
    anyText[0] ??
    "";

  const cardKey = cardColumns.find((c) => c.index === ROLE_KEY && names.has(c.name))?.name;
  const keyColumn = cardKey ?? fields.find((f) => KEY_NAME.test(f.name))?.name ?? ENGINE_ID_COLUMN;

  const rowColumns = fields.filter((f) => f.type !== EMBEDDING_TYPE && f.type !== VECTOR_TYPE).map((f) => f.name);
  if (keyColumn === ENGINE_ID_COLUMN) rowColumns.unshift(ENGINE_ID_COLUMN);
  // A table with its own `score` column names it once: the platform reads a
  // repeated name as one projection either way, and a hit has one cell.
  const projection = rowColumns.includes(SCORE_COLUMN) ? [...rowColumns] : [...rowColumns, SCORE_COLUMN];

  const text = new Set(textColumns);
  const listColumns = fields.filter((f) => f.type === LIST_TYPE).map((f) => f.name);
  const scalarColumns = fields
    .filter((f) => !text.has(f.name) && f.type !== LIST_TYPE && f.type !== EMBEDDING_TYPE && f.type !== VECTOR_TYPE)
    .map((f) => f.name);

  return {
    table,
    columns: fields.map((f) => ({ name: f.name, type: renderType(f) })),
    vectorColumn,
    vectorSource,
    textColumns,
    textColumnsInferred,
    primaryText,
    scalarColumns,
    listColumns,
    keyColumn,
    isChunks: CHUNK_COLUMNS.every((name) => names.has(name)),
    rowColumns,
    projection,
    ...(card ? { card } : {}),
  };
}

/** The shape of `table` on the hosted database: its schema, and its card at
 * `cardTier` when the platform has one. The card is best-effort - a table
 * the optimizer has not swept yet has none, and the schema alone describes
 * such a table well enough to search it - but the schema is not: without it
 * nothing here knows what to ask for. `onNoCard` hears why the card was not
 * served, for a caller that wants to log the platform's words; the shape
 * itself just goes without one. Two reads, the only two a shape costs. */
export async function resolveTableShape(
  hosted: Pick<HostedDb, "schema" | "tableCard">,
  table: string,
  cardTier?: string,
  onNoCard?: (err: unknown) => void,
): Promise<TableShape> {
  const fields = (await hosted.schema(table)) as unknown;
  if (!Array.isArray(fields)) throw new Error(`schema of ${table}: expected the platform's column descriptors, got ${typeof fields}`);
  let card: RowRecord | null = null;
  try {
    const record = await hosted.tableCard(table, cardTier);
    // The route answers the card bare or wrapped in a record, as the sql
    // description's own fetch has always allowed for.
    const inner = record?.card ?? record;
    if (inner && typeof inner === "object") card = inner as RowRecord;
  } catch (err) {
    // no card yet: the schema alone stands
    onNoCard?.(err);
  }
  return tableShapeFrom(table, fields as SchemaField[], card);
}

// --- rows as hits -----------------------------------------------------------------

/** Characters kept of a text column in a search or find hit. The text is a
 * snippet - enough to tell what the row is and whether it is the one - and
 * the whole value is one `sql` away by the row's key. A job description runs
 * to several thousand characters of HTML, and ten of those per search would
 * cost more than the answer. */
export const SNIPPET_CHARS = 500;

/** The named entities HTML text carries most - the five the escaping itself
 * produces, and the typographic ones a posting's editor writes - decoded so a
 * snippet reads as prose; numeric references are decoded by rule, and any
 * other name is left as it came. */
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u{2014}",
  ndash: "\u{2013}",
  hellip: "\u{2026}",
  lsquo: "\u{2018}",
  rsquo: "\u{2019}",
  ldquo: "\u{201C}",
  rdquo: "\u{201D}",
  bull: "\u{2022}",
};
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const TAG = /<[^>]*>/g;
const WHITESPACE = /\s+/g;

/** What marks a value as HTML rather than prose that happens to hold a `<`:
 * a tag - `<` and a letter, an optional closing slash before it - found at
 * least HTML_TAGS_MIN times, or a column whose name says so. One tag is not
 * enough: `Vec<T>` is one, and so is a bare `<br>` in a sentence that is
 * otherwise plain. Below the bar the text is kept as it came - a description
 * saying `retry while attempts < max and backoff > 0` loses its middle to a
 * tag stripper that does not ask first. */
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const HTML_TAGS_MIN = 2;
const HTML_COLUMN = /html/i;

/** The largest Unicode scalar value; a numeric reference past it is left as
 * it came rather than thrown on. */
const MAX_CODE_POINT = 0x10ffff;

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] !== "#") return HTML_ENTITIES[body.toLowerCase()] ?? whole;
    const hex = body[1] === "x" || body[1] === "X";
    const codePoint = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : whole;
  });
}

/** Whether `text`, in a column named `column`, is HTML: the column says so,
 * or the text holds HTML_TAGS_MIN tags once its entities are decoded - a
 * stored description is often HTML that was itself entity-escaped, so
 * `&lt;p&gt;` is a tag only once decoded. */
export function looksLikeHtml(text: string, column = ""): boolean {
  if (HTML_COLUMN.test(column)) return true;
  const tags = decodeEntities(text).match(HTML_TAG);
  return tags !== null && tags.length >= HTML_TAGS_MIN;
}

/** `text` as a snippet: whitespace collapsed, cut to SNIPPET_CHARS with a
 * marker on the cut; and when the value is HTML (looksLikeHtml), its tags
 * stripped and its entities decoded first. Entities are decoded before the
 * tags go, since an escaped `&lt;p&gt;` is a tag only once decoded, and once
 * more after, for the `&amp;nbsp;` the first pass turns into an entity.
 * Plain text keeps every character it came with, `<` and `&` included. */
export function snippet(text: string, column?: string): string {
  const prose = looksLikeHtml(text, column) ? decodeEntities(decodeEntities(text).replace(TAG, " ")) : text;
  const plain = prose.replace(WHITESPACE, " ").trim();
  return plain.length > SNIPPET_CHARS ? `${plain.slice(0, SNIPPET_CHARS)}...` : plain;
}

/** A row as a hit: `score` first, then the key, then the other columns in
 * schema order, then the text columns as snippets - so a reader sees what
 * the row is before what it says, and a long text never buries the columns
 * after it. Cells the platform omitted (nulls) stay absent. */
export function rowHit(row: RowRecord, shape: TableShape): RowRecord {
  const text = new Set(shape.textColumns);
  const out: RowRecord = {};
  if (row[SCORE_COLUMN] !== undefined) out[SCORE_COLUMN] = row[SCORE_COLUMN];
  if (row[shape.keyColumn] !== undefined) out[shape.keyColumn] = row[shape.keyColumn];
  for (const name of shape.rowColumns) {
    if (name === SCORE_COLUMN || name === shape.keyColumn || text.has(name) || row[name] === undefined) continue;
    out[name] = row[name];
  }
  for (const name of shape.textColumns) {
    const cell = row[name];
    if (typeof cell === "string") out[name] = snippet(cell, name);
    else if (cell !== undefined) out[name] = cell;
  }
  return out;
}

/** A fact of the platform's loop as a row: `rowHit`'s order and snippets for
 * the table's own columns, then every cell the statement made that is no
 * column of the table's - an aggregate's count, an expression's alias - as
 * it came. A loop's statement is not a projection of the table: `SELECT
 * department, COUNT(*) AS n` is a fact whose answer is the alias, and a hit
 * that carried the table's columns alone would drop it. A cell named for a
 * column the hit leaves out (the vector) stays out. */
export function rowFact(row: RowRecord, shape: TableShape): RowRecord {
  const columns = new Set(shape.columns.map((c) => c.name));
  const out = rowHit(row, shape);
  for (const [name, value] of Object.entries(row)) {
    if (!(name in out) && !columns.has(name) && value !== undefined) out[name] = value;
  }
  return out;
}

/** What identifies `row` in the usage ledger: its key, or the engine id
 * when the key was not returned. */
export function rowKey(row: RowRecord, shape: TableShape): string {
  return String(row[shape.keyColumn] ?? row[ENGINE_ID_COLUMN] ?? "");
}

// --- SQL spelling -------------------------------------------------------------------

/** `text` as a SQL string literal: quotes doubled, the only escaping a
 * literal needs and the whole of the injection surface. */
export function sqlLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** `name` as a quoted SQL identifier, so a column named with a capital or a
 * space reaches the engine as spelled. */
export function sqlIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
