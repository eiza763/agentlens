/**
 * Minimal client for the SigNoz query API (v5).
 *
 * Docs: https://signoz.io/docs/apm-and-distributed-tracing/traces-api/
 *       https://signoz.io/docs/traces-management/trace-api/payload-model/
 *
 * Endpoint: POST {SIGNOZ_API_URL}/api/v5/query_range
 * Auth:     SIGNOZ-API-KEY header (Settings -> Service Accounts -> Keys)
 *
 * The response envelope has shifted between SigNoz versions, so rather than
 * hard-coding one path we walk the response for the first array of row objects.
 * `AGENTLENS_DEBUG=1` prints the raw payload when a query returns nothing, which
 * is the fastest way to adapt if your workspace returns a different shape.
 */
import { config } from "../config.js";

export type Row = Record<string, unknown>;

export interface SelectField {
  name: string;
  fieldContext?: "resource" | "span" | "attribute";
  fieldDataType?: "string" | "int64" | "float64" | "bool";
}

export interface RawQueryOptions {
  /** Filter expression, e.g. `service.name = 'agentlens-agent' AND has_error = true` */
  expression: string;
  selectFields: SelectField[];
  startMs: number;
  endMs: number;
  limit?: number;
  orderDesc?: boolean;
}

async function queryRange(body: unknown): Promise<unknown> {
  const url = `${config.signozApiUrl}/api/v5/query_range`;
  const apiKey = config.signozApiKey;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "SIGNOZ-API-KEY": apiKey } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `SigNoz query failed (${res.status} ${res.statusText}) at ${url}\n` +
        `Response: ${text.slice(0, 800)}\n` +
        `Check SIGNOZ_API_URL (workspace URL, no trailing slash) and SIGNOZ_API_KEY.`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`SigNoz returned non-JSON response: ${text.slice(0, 400)}`);
  }
}

/**
 * Pull the first plausible array of result rows out of the response envelope.
 *
 * Row objects sometimes arrive as `{ timestamp, data: {...} }` and sometimes
 * flat; both are normalised to a flat record here.
 */
export function extractRows(response: unknown): Row[] {
  const candidates: Row[][] = [];

  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== "object") return;

    if (Array.isArray(node)) {
      const objects = node.filter(
        (item): item is Row => item !== null && typeof item === "object" && !Array.isArray(item),
      );
      // A results array is one whose elements carry span-ish payloads.
      if (objects.length > 0 && objects.length === node.length) {
        const looksLikeRows = objects.some(
          (o) => "data" in o || "timestamp" in o || "trace_id" in o || "traceId" in o,
        );
        if (looksLikeRows) candidates.push(objects);
      }
      for (const item of node) walk(item, depth + 1);
      return;
    }

    for (const value of Object.values(node as Row)) walk(value, depth + 1);
  };

  walk(response, 0);

  if (candidates.length === 0) return [];

  // Prefer the largest candidate: nested `results` wrappers produce small
  // single-element arrays that would otherwise win.
  const best = candidates.reduce((a, b) => (b.length > a.length ? b : a));

  return best.map((row) => {
    const data = row.data;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      return { ...(data as Row), ...(row.timestamp !== undefined ? { timestamp: row.timestamp } : {}) };
    }
    return row;
  });
}

/** Fetch raw spans matching a filter expression. */
export async function queryRawSpans(opts: RawQueryOptions): Promise<Row[]> {
  const body = {
    start: opts.startMs,
    end: opts.endMs,
    requestType: "raw",
    variables: {},
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            filter: { expression: opts.expression },
            selectFields: opts.selectFields,
            order: [{ key: { name: "timestamp" }, direction: opts.orderDesc === false ? "asc" : "desc" }],
            limit: opts.limit ?? 100,
            offset: 0,
            disabled: false,
          },
        },
      ],
    },
  };

  const response = await queryRange(body);
  const rows = extractRows(response);

  if (rows.length === 0 && config.debug) {
    console.error("[signoz] query returned no rows. Filter:", opts.expression);
    console.error("[signoz] raw response:", JSON.stringify(response, null, 2).slice(0, 4000));
  }

  return rows;
}

/**
 * Run a scalar aggregation over spans, e.g. avg of an eval score attribute.
 * Returns the first numeric value found, or null when there is no data.
 */
export async function queryScalar(opts: {
  expression: string;
  aggregation: string;
  startMs: number;
  endMs: number;
}): Promise<number | null> {
  const body = {
    start: opts.startMs,
    end: opts.endMs,
    requestType: "scalar",
    variables: {},
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            filter: { expression: opts.expression },
            aggregations: [{ expression: opts.aggregation }],
            disabled: false,
          },
        },
      ],
    },
  };

  const response = await queryRange(body);
  const rows = extractRows(response);

  for (const row of rows) {
    for (const value of Object.values(row)) {
      const num = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(num) && String(value).trim() !== "") return num;
    }
  }

  if (config.debug) {
    console.error("[signoz] scalar query produced no numeric value.");
    console.error("[signoz] raw response:", JSON.stringify(response, null, 2).slice(0, 4000));
  }
  return null;
}

/** Convenience: read a string attribute off a row, tolerating naming variants. */
export function attr(row: Row, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && value !== "") return String(value);
    // Attributes are occasionally nested under a bag.
    for (const bag of ["attributes", "attributes_string", "tags", "stringTagMap"]) {
      const container = row[bag];
      if (container && typeof container === "object") {
        const nested = (container as Row)[name];
        if (nested !== undefined && nested !== null && nested !== "") return String(nested);
      }
    }
  }
  return undefined;
}

export function numAttr(row: Row, ...names: string[]): number | undefined {
  const raw = attr(row, ...names);
  if (raw === undefined) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}
