import { createReadStream } from "fs";
import { createGunzip } from "zlib";
import { createInterface } from "readline";
import { z } from "zod";
import type { Namespace } from "./download";

export interface WikiRecord {
  id: string;
  title: string;
  text: string;
  vector: number[];
}

const WikiRecordSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().min(1),
  text: z.string().min(1),
  vector: z.array(z.number()).min(1),
});

// Different files use different column names for the embedding vector
const VECTOR_COLUMN_NAMES: Record<Namespace, string[]> = {
  "wiki-openai": ["text-embedding-ada-002", "embedding", "content_vector"],
  "wiki-minilm": ["all-MiniLM-L6-v2", "minilm", "embedding"],
  "wiki-gte": ["gte-small", "gte", "embedding"],
  "wiki-3-small": ["text-embedding-3-small", "embedding"],
  "wiki-3-large": ["text-embedding-3-large", "embedding"],
};

function findVectorColumn(record: Record<string, unknown>, namespace: Namespace): number[] | null {
  const candidates = VECTOR_COLUMN_NAMES[namespace];
  for (const col of candidates) {
    if (Array.isArray(record[col])) {
      return record[col] as number[];
    }
  }
  // Fallback: look for any array of numbers with reasonable length
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value) && value.length > 100 && typeof value[0] === "number") {
      console.log(`  [Auto-detected vector column: "${key}"]`);
      return value as number[];
    }
  }
  return null;
}

// Parse "Title: ... Content: ..." format from body field
function parseBody(body: string): { title: string; text: string } | null {
  const titleMatch = body.match(/^Title:\s*(.+?)\s*Content:\s*/);
  if (!titleMatch) {
    // Fallback: use entire body as text with empty title
    return { title: "", text: body };
  }
  const title = titleMatch[1].trim();
  const text = body.slice(titleMatch[0].length).trim();
  return { title, text };
}

function normalizeRecord(raw: Record<string, unknown>, namespace: Namespace): WikiRecord | null {
  const vector = findVectorColumn(raw, namespace);
  if (!vector) return null;

  const body = raw.body as string | undefined;
  if (!body) return null;

  const parsed = parseBody(body);
  if (!parsed) return null;

  const normalized = {
    id: raw.id,
    title: parsed.title,
    text: parsed.text,
    vector,
  };

  const result = WikiRecordSchema.safeParse(normalized);
  if (!result.success) return null;
  return result.data;
}

export async function* parseNdjsonGz(
  filePath: string,
  namespace: Namespace,
  options: { limit?: number; logFirstRecord?: boolean } = {}
): AsyncGenerator<WikiRecord> {
  const { limit, logFirstRecord = true } = options;

  const gunzip = createGunzip();
  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream.pipe(gunzip),
    crlfDelay: Infinity,
  });

  let count = 0;
  let firstLogged = false;

  for await (const line of rl) {
    if (limit && count >= limit) break;

    try {
      const raw = JSON.parse(line) as Record<string, unknown>;

      if (!firstLogged && logFirstRecord) {
        console.log(`  [First record keys: ${Object.keys(raw).join(", ")}]`);
        firstLogged = true;
      }

      const record = normalizeRecord(raw, namespace);
      if (record) {
        count++;
        yield record;
      }
    } catch {
      // Skip malformed lines
    }
  }
}
