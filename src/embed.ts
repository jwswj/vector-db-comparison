import OpenAI from "openai";
import pLimit from "p-limit";
import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from "fs";
import { createGunzip, createGzip } from "zlib";
import { createInterface } from "readline";
import { mkdir } from "fs/promises";
import { join } from "path";
import { DATA_DIR, getDatasetPath, type Namespace } from "./download";

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 1000;

// Cost per 1M tokens
const COST_PER_1M_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
};

export type EmbeddingModel = "text-embedding-3-small" | "text-embedding-3-large";

const MODEL_DIMENSIONS: Record<EmbeddingModel, number> = {
  "text-embedding-3-small": 512,
  "text-embedding-3-large": 1024,
};

const MODEL_NAMESPACE: Record<EmbeddingModel, Namespace> = {
  "text-embedding-3-small": "wiki-3-small",
  "text-embedding-3-large": "wiki-3-large",
};

export interface EmbedOptions {
  model: EmbeddingModel;
  sourceNamespace: Namespace;
  limit?: number;
  batchSize?: number;
  concurrency?: number;
}

interface SourceRecord {
  id: string;
  body: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCursorPath(model: string): string {
  return join(DATA_DIR, `embed-${model}.cursor`);
}

function loadCursor(model: string): number {
  const path = getCursorPath(model);
  if (existsSync(path)) {
    const value = readFileSync(path, "utf-8").trim();
    return parseInt(value, 10) || 0;
  }
  return 0;
}

function saveCursor(model: string, count: number): void {
  writeFileSync(getCursorPath(model), String(count));
}

async function* readSourceRecords(
  filePath: string,
  options: { limit?: number; skip?: number } = {}
): AsyncGenerator<SourceRecord> {
  const { limit, skip = 0 } = options;

  const gunzip = createGunzip();
  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream.pipe(gunzip),
    crlfDelay: Infinity,
  });

  let lineIndex = 0;
  let yielded = 0;

  for await (const line of rl) {
    if (lineIndex < skip) {
      lineIndex++;
      continue;
    }
    if (limit && yielded >= limit) break;

    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const id = raw.id;
      const body = raw.body;
      if (id != null && typeof body === "string" && body.length > 0) {
        yielded++;
        yield { id: String(id), body };
      }
    } catch {
      // Skip malformed lines
    }
    lineIndex++;
  }
}

async function embedBatchWithRetry(
  client: OpenAI,
  texts: string[],
  model: EmbeddingModel,
  dimensions: number
): Promise<{ embeddings: number[][]; totalTokens: number }> {
  let attempt = 0;
  while (true) {
    try {
      const response = await client.embeddings.create({
        model,
        input: texts,
        dimensions,
      });

      const embeddings = response.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);

      return {
        embeddings,
        totalTokens: response.usage.total_tokens,
      };
    } catch (e) {
      const err = e as { status?: number; message?: string; headers?: Headers };
      const isRetryable =
        err.status === 429 || (err.status !== undefined && err.status >= 500);

      if (isRetryable && attempt < MAX_RETRIES) {
        attempt++;

        // Respect Retry-After header from OpenAI 429 responses
        let backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
        const retryAfter = err.headers?.get("retry-after");
        if (retryAfter) {
          const retryAfterMs = parseFloat(retryAfter) * 1000;
          if (!isNaN(retryAfterMs) && retryAfterMs > 0) {
            backoff = Math.max(backoff, retryAfterMs);
          }
        }

        process.stdout.write(
          `\n  [Retry ${attempt}/${MAX_RETRIES}] ${err.status} — waiting ${(backoff / 1000).toFixed(1)}s\n`
        );
        await sleep(backoff);
        continue;
      }
      throw e;
    }
  }
}

function formatCost(totalTokens: number, model: string): string {
  const costPer1M = COST_PER_1M_TOKENS[model] ?? 0;
  const cost = (totalTokens / 1_000_000) * costPer1M;
  return `$${cost.toFixed(2)}`;
}

export async function embedDataset(options: EmbedOptions): Promise<void> {
  const {
    model,
    sourceNamespace,
    limit,
    batchSize = 100,
    concurrency = 1,
  } = options;

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }

  const client = new OpenAI();
  const dimensions = MODEL_DIMENSIONS[model];
  const targetNamespace = MODEL_NAMESPACE[model];
  const sourcePath = getDatasetPath(sourceNamespace);

  if (!existsSync(sourcePath)) {
    throw new Error(
      `Source file not found: ${sourcePath}\nRun 'download' first to get the source dataset.`
    );
  }

  await mkdir(DATA_DIR, { recursive: true });

  const outputPath = getDatasetPath(targetNamespace);
  const cursorCount = loadCursor(model);

  console.log(`\nEmbedding pipeline: ${model} (${dimensions}d)`);
  console.log(`  Source: ${sourceNamespace} → ${sourcePath}`);
  console.log(`  Output: ${outputPath}`);
  console.log(`  Batch size: ${batchSize}, Concurrency: ${concurrency}`);
  if (limit) console.log(`  Limit: ${limit} records`);
  if (cursorCount > 0) console.log(`  Resuming from record ${cursorCount}`);

  // Open output file in append mode if resuming, otherwise create new
  const outputFlags = cursorCount > 0 ? "a" : "w";
  const gzip = createGzip();
  const outputStream = createWriteStream(outputPath, { flags: outputFlags });
  gzip.pipe(outputStream);

  const limiter = pLimit(concurrency);
  const pendingWrites: Promise<void>[] = [];

  let totalEmbedded = cursorCount;
  let totalTokens = 0;
  let batch: SourceRecord[] = [];

  const effectiveLimit = limit ? limit + cursorCount : undefined;

  const processBatch = (records: SourceRecord[]) => {
    const promise = limiter(async () => {
      const texts = records.map((r) => r.body);

      const { embeddings, totalTokens: batchTokens } =
        await embedBatchWithRetry(client, texts, model, dimensions);

      totalTokens += batchTokens;

      // Write results as NDJSON
      for (let i = 0; i < records.length; i++) {
        const output: Record<string, unknown> = {
          id: records[i].id,
          body: records[i].body,
          [model]: embeddings[i],
        };
        const line = JSON.stringify(output) + "\n";
        gzip.write(line);
      }

      totalEmbedded += records.length;
      saveCursor(model, totalEmbedded);

      const total = limit ? limit + cursorCount : "all";
      process.stdout.write(
        `\r  [${targetNamespace}] Embedded ${totalEmbedded.toLocaleString()} / ${typeof total === "number" ? total.toLocaleString() : total} (${formatCost(totalTokens, model)} spent)   `
      );
    });
    pendingWrites.push(promise);
  };

  for await (const record of readSourceRecords(sourcePath, {
    limit: effectiveLimit,
    skip: cursorCount,
  })) {
    batch.push(record);

    if (batch.length >= batchSize) {
      processBatch(batch);
      batch = [];
    }
  }

  // Final batch
  if (batch.length > 0) {
    processBatch(batch);
  }

  await Promise.all(pendingWrites);

  // Close the gzip stream and wait for it to finish
  await new Promise<void>((resolve, reject) => {
    gzip.end(() => {
      outputStream.on("finish", resolve);
      outputStream.on("error", reject);
    });
  });

  const embedded = totalEmbedded - cursorCount;
  console.log(
    `\n\n  Completed: ${embedded.toLocaleString()} records embedded`
  );
  console.log(`  Total tokens: ${totalTokens.toLocaleString()}`);
  console.log(`  Estimated cost: ${formatCost(totalTokens, model)}`);
  console.log(`  Output: ${outputPath}`);
}
