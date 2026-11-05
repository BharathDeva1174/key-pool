import { keyFingerprint, normalizeKey } from './crypto.js';

export type BulkRowStatus = 'ok' | 'duplicate' | 'invalid';
export type BulkFormat = 'auto' | 'text' | 'json' | 'csv';

export interface BulkRow {
  index: number; // 1-based, matches what the UI shows
  raw: string;
  key: string; // normalised (no `Bearer ` prefix, no quotes)
  label: string | null;
  baseUrl: string | null;
  modelId: string | null;
  status: BulkRowStatus;
  reason: string | null;
  fingerprint: string;
}

export interface BulkParseResult {
  format: Exclude<BulkFormat, 'auto'>;
  rows: BulkRow[];
  summary: { total: number; ok: number; duplicates: number; invalid: number };
}

export interface BulkParseOptions {
  format?: BulkFormat;
  /** When set, rows naming a different upstream are rejected rather than mis-filed. */
  targetBaseUrl?: string;
  maxBytes?: number;
}

export const DEFAULT_MAX_BULK_BYTES = 2 * 1024 * 1024; // 2 MB

const KEY_COLUMNS = ['api_key', 'apikey', 'api key', 'key', 'token', 'secret', 'bearer'];
const BASE_COLUMNS = ['base_url', 'baseurl', 'base url', 'url', 'endpoint', 'api_base', 'api_base_url', 'host'];
const MODEL_COLUMNS = ['model', 'model_id', 'modelid', 'model id', 'model_name'];
const LABEL_COLUMNS = ['label', 'name', 'description', 'note', 'alias'];

/** Splits a CSV document into rows of cells, honouring quoted fields. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      inQuotes = true;
      field = '';
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    field += ch;
  }
  row.push(field);
  rows.push(row);

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function matchColumn(header: string, names: string[]): number {
  const h = header.trim().toLowerCase().replace(/^\ufeff/, '');
  const direct = names.findIndex((n) => n === h);
  if (direct !== -1) return direct;
  return names.findIndex((n) => h.includes(n));
}

function looksLikeCsv(text: string): boolean {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '');
  if (!firstLine || !/[;,\t]/.test(firstLine)) return false;
  const cells = firstLine.split(/[;,]/).map((c) => c.trim().toLowerCase());
  return (
    matchColumn(cells[0] ?? '', KEY_COLUMNS) !== -1 ||
    cells.some((c) => matchColumn(c, KEY_COLUMNS) !== -1)
  );
}

function detectFormat(text: string): Exclude<BulkFormat, 'auto'> {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json';
  if (looksLikeCsv(text)) return 'csv';
  return 'text';
}

function baseUrlKey(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Parses a bulk key payload in any of the supported shapes.
 *
 * Plain text, JSON (array of strings or objects) and CSV all normalise to the
 * same row list, deduped by fingerprint, with a per-row reason so the operator
 * can see exactly what happened to every line they pasted.
 */
export function parseBulkKeys(input: string, options: BulkParseOptions = {}): BulkParseResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BULK_BYTES;
  const text = input ?? '';
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`Bulk payload is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }

  const format = options.format && options.format !== 'auto' ? options.format : detectFormat(text);
  const rawItems: ParsedItem[] =
    format === 'json' ? parseJsonItems(text) : format === 'csv' ? parseCsvItems(text) : parseTextItems(text);

  const seen = new Set<string>();
  const rows: BulkRow[] = [];
  let index = 0;

  for (const item of rawItems) {
    index += 1;
    const key = normalizeKey(item.key);
    const row: BulkRow = {
      index,
      raw: item.raw,
      key,
      label: item.label ?? null,
      baseUrl: item.baseUrl ?? null,
      modelId: item.modelId ?? null,
      status: 'ok',
      reason: null,
      fingerprint: key ? keyFingerprint(key) : '',
    };

    if (!key) {
      row.status = 'invalid';
      row.reason = 'Empty key after normalisation.';
    } else if (key.length < 8) {
      row.status = 'invalid';
      row.reason = `Suspiciously short (${key.length} chars).`;
    } else if (options.targetBaseUrl && item.baseUrl) {
      const wanted = baseUrlKey(options.targetBaseUrl);
      const got = baseUrlKey(item.baseUrl);
      // Compare with and without the /v1 suffix so either paste shape matches.
      const same = got === wanted || got.replace(/\/v1$/, '') === wanted.replace(/\/v1$/, '');
      if (!same) {
        row.status = 'invalid';
        row.reason = `Names a different base URL (${item.baseUrl}); expected ${options.targetBaseUrl}.`;
      }
    } else if (seen.has(row.fingerprint)) {
      row.status = 'duplicate';
      row.reason = 'Already present earlier in this import.';
    }

    if (row.status === 'ok') seen.add(row.fingerprint);
    rows.push(row);
  }

  return {
    format,
    rows,
    summary: {
      total: rows.length,
      ok: rows.filter((r) => r.status === 'ok').length,
      duplicates: rows.filter((r) => r.status === 'duplicate').length,
      invalid: rows.filter((r) => r.status === 'invalid').length,
    },
  };
}

interface ParsedItem {
  raw: string;
  key: string;
  label?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
}

function parseTextItems(text: string): ParsedItem[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .flatMap((line) => line.split(/[;,]/))
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '' && !piece.startsWith('#'))
    .map((piece) => ({ raw: piece, key: piece }));
}

function parseJsonItems(text: string): ParsedItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Bulk payload looks like JSON but did not parse: ${(err as Error).message}`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { keys?: unknown })?.keys;
  if (!Array.isArray(list)) {
    throw new Error('JSON bulk payload must be an array, or an object with a "keys" array.');
  }
  return list.map((item) => {
    if (typeof item === 'string') return { raw: item, key: item };
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const key = firstString(o, ['api_key', 'apiKey', 'apikey', 'key', 'token', 'secret', 'bearer']) ?? '';
      return {
        raw: key,
        key,
        label: firstString(o, LABEL_COLUMNS) ?? null,
        baseUrl: firstString(o, BASE_COLUMNS) ?? null,
        modelId: firstString(o, MODEL_COLUMNS) ?? null,
      };
    }
    return { raw: String(item), key: '' };
  });
}

function parseCsvItems(text: string): ParsedItem[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = (rows[0] as string[]).map((c) => c.trim().toLowerCase().replace(/^\ufeff/, ''));

  const keyIdx = matchColumn(header[0] ?? '', KEY_COLUMNS);
  const hasKnownHeader = header.some((c) => matchColumn(c, KEY_COLUMNS) !== -1);

  // Headerless CSV: treat every row as a single key.
  if (!hasKnownHeader) {
    return rows.map((r) => ({ raw: (r[0] ?? '').trim(), key: (r[0] ?? '').trim() }));
  }

  const keyCol = keyIdx === -1 ? header.findIndex((c) => matchColumn(c, KEY_COLUMNS) !== -1) : keyIdx;
  const baseCol = header.findIndex((c) => matchColumn(c, BASE_COLUMNS) !== -1);
  const modelCol = header.findIndex((c) => matchColumn(c, MODEL_COLUMNS) !== -1);
  const labelCol = header.findIndex((c) => matchColumn(c, LABEL_COLUMNS) !== -1);

  return rows.slice(1).map((r) => ({
    raw: (r[keyCol] ?? '').trim(),
    key: (r[keyCol] ?? '').trim(),
    label: labelCol !== -1 ? (r[labelCol] ?? '').trim() || null : null,
    baseUrl: baseCol !== -1 ? (r[baseCol] ?? '').trim() || null : null,
    modelId: modelCol !== -1 ? (r[modelCol] ?? '').trim() || null : null,
  }));
}

function firstString(obj: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = obj[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}
