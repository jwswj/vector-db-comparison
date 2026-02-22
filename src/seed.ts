import pLimit from "p-limit";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDatasetPath, DATA_DIR, NAMESPACES, type Namespace } from "./download";
import { parseNdjsonGz, type WikiRecord } from "./parse";
import type { VectorBackend } from "./backend";

export interface SeedOptions {
  namespace?: Namespace;
  limit?: number;
  batchSize?: number;
  concurrency?: number;
  backend: VectorBackend;
}

function getCursorPath(namespace: string): string {
  return join(DATA_DIR, `${namespace}.cursor`);
}

function loadCursor(namespace: string): string | null {
  const path = getCursorPath(namespace);
  if (existsSync(path)) {
    return readFileSync(path, "utf-8").trim();
  }
  return null;
}

function saveCursor(namespace: string, lastId: string): void {
  writeFileSync(getCursorPath(namespace), lastId);
}

async function seedNamespace(
  namespace: Namespace,
  options: { limit?: number; batchSize: number; concurrency: number; backend: VectorBackend }
): Promise<void> {
  const { limit, batchSize, concurrency, backend } = options;
  const filePath = getDatasetPath(namespace);

  if (!existsSync(filePath)) {
    console.log(`Skipping ${namespace}: data file not found. Run 'download' first.`);
    return;
  }

  console.log(`\nSeeding ${namespace}...`);

  await backend.ensureNamespace(namespace);
  const ns = backend.namespace(namespace);
  const limiter = pLimit(concurrency);
  const cursor = loadCursor(namespace);

  let batch: WikiRecord[] = [];
  let totalUpserted = 0;
  let skipped = 0;
  let seenCursor = !cursor;
  const pendingUpserts: Promise<void>[] = [];

  let isFirstBatch = true;

  for await (const record of parseNdjsonGz(filePath, namespace, { limit })) {
    // Resume from cursor
    if (!seenCursor) {
      if (record.id === cursor) {
        seenCursor = true;
      }
      skipped++;
      continue;
    }

    batch.push(record);

    if (batch.length >= batchSize) {
      const batchToUpsert = batch;
      const isFirst = isFirstBatch;
      isFirstBatch = false;
      batch = [];

      const upsert = limiter(async () => {
        await ns.upsert(batchToUpsert, { isFirstBatch: isFirst });
        totalUpserted += batchToUpsert.length;
        const lastId = batchToUpsert[batchToUpsert.length - 1].id;
        saveCursor(namespace, lastId);

        const total = limit || "all";
        process.stdout.write(
          `\r  [${namespace}] Upserted ${totalUpserted.toLocaleString()} / ${total} rows   `
        );
      });

      pendingUpserts.push(upsert);
    }
  }

  // Final batch
  if (batch.length > 0) {
    const isFirst = isFirstBatch;
    pendingUpserts.push(
      limiter(async () => {
        await ns.upsert(batch, { isFirstBatch: isFirst });
        totalUpserted += batch.length;
        const lastId = batch[batch.length - 1].id;
        saveCursor(namespace, lastId);
      })
    );
  }

  await Promise.all(pendingUpserts);

  console.log(`\n  Completed ${namespace}: ${totalUpserted.toLocaleString()} rows upserted`);
  if (skipped > 0) {
    console.log(`  (Skipped ${skipped.toLocaleString()} rows from previous run)`);
  }
}

export async function seed(options: SeedOptions): Promise<void> {
  const { namespace, limit, batchSize = 256, concurrency = 3, backend } = options;

  const namespacesToSeed = namespace ? [namespace] : NAMESPACES;

  console.log(`Seeding ${namespacesToSeed.length} namespace(s)...`);
  if (limit) console.log(`Limit: ${limit} records per namespace`);
  console.log(`Batch size: ${batchSize}, Concurrency: ${concurrency}`);

  for (const ns of namespacesToSeed) {
    await seedNamespace(ns, { limit, batchSize, concurrency, backend });
  }

  console.log("\nSeeding complete!");
}
