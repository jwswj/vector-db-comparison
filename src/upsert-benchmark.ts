import { NAMESPACES, type Namespace } from "./download";
import type { VectorBackend } from "./backend";
import type { WikiRecord } from "./parse";

const DEFAULT_TOTAL_RECORDS = 10000;
const DEFAULT_BATCH_SIZE = 256;

export interface UpsertBenchmarkOptions {
  backend: VectorBackend;
  backendName: string;
  namespace: Namespace;
  totalRecords?: number;
  batchSize?: number;
  output?: string;
}

export interface UpsertResult {
  backend: string;
  namespace: string;
  dimensions: number;
  total_records: number;
  batch_size: number;
  num_batches: number;
  duration_seconds: number;
  records_per_second: number;
  batch_latencies_ms: number[];
  avg_batch_latency_ms: number;
  p95_batch_latency_ms: number;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

const DIMENSION_MAP: Record<Namespace, number> = {
  "wiki-openai": 1536,
  "wiki-minilm": 384,
  "wiki-gte": 384,
  "wiki-3-small": 512,
  "wiki-3-large": 1024,
};

function generateSyntheticRecords(namespace: Namespace, count: number): WikiRecord[] {
  const dimensions = DIMENSION_MAP[namespace];
  const records: WikiRecord[] = [];

  for (let i = 0; i < count; i++) {
    // Generate random normalized vector
    const vector = new Array(dimensions).fill(0).map(() => Math.random() * 2 - 1);
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    const normalizedVector = vector.map(v => v / norm);

    records.push({
      id: `benchmark-${Date.now()}-${i}`,
      title: `Benchmark Document ${i}`,
      text: `This is synthetic benchmark document number ${i}. It contains some text for testing upsert performance. The content is meaningless but ensures we're testing realistic document sizes with typical metadata. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
      vector: normalizedVector,
    });
  }

  return records;
}

export async function runUpsertBenchmark(options: UpsertBenchmarkOptions): Promise<UpsertResult> {
  const totalRecords = options.totalRecords ?? DEFAULT_TOTAL_RECORDS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const namespace = options.namespace;
  const dimensions = DIMENSION_MAP[namespace];

  console.log("Upsert Benchmark (Write Performance)");
  console.log("====================================");
  console.log(`Backend: ${options.backendName}`);
  console.log(`Namespace: ${namespace} (${dimensions}d)`);
  console.log(`Total records: ${totalRecords}`);
  console.log(`Batch size: ${batchSize}`);
  console.log("");

  // Generate synthetic records
  console.log("Generating synthetic records...");
  const records = generateSyntheticRecords(namespace, totalRecords);
  console.log(`Generated ${records.length} records`);

  // Ensure namespace exists
  await options.backend.ensureNamespace(namespace);
  const ns = options.backend.namespace(namespace);

  // Run upserts in batches
  const batchLatencies: number[] = [];
  const numBatches = Math.ceil(records.length / batchSize);

  console.log(`\nUpserting in ${numBatches} batches...`);
  const startTime = performance.now();

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    const batchStart = performance.now();
    await ns.upsert(batch, { isFirstBatch: i === 0 });
    const batchEnd = performance.now();

    const batchLatency = batchEnd - batchStart;
    batchLatencies.push(batchLatency);

    if (batchNum % 10 === 0 || batchNum === numBatches) {
      const progress = ((batchNum / numBatches) * 100).toFixed(1);
      const currentRps = (i + batch.length) / ((batchEnd - startTime) / 1000);
      process.stdout.write(`\r  Batch ${batchNum}/${numBatches} (${progress}%) - ${currentRps.toFixed(0)} records/sec`);
    }
  }

  const endTime = performance.now();
  const durationSeconds = (endTime - startTime) / 1000;

  console.log("\n");

  const result: UpsertResult = {
    backend: options.backendName,
    namespace,
    dimensions,
    total_records: totalRecords,
    batch_size: batchSize,
    num_batches: numBatches,
    duration_seconds: durationSeconds,
    records_per_second: totalRecords / durationSeconds,
    batch_latencies_ms: batchLatencies,
    avg_batch_latency_ms: mean(batchLatencies),
    p95_batch_latency_ms: percentile(batchLatencies, 95),
  };

  console.log("Results:");
  console.log(`  Total duration: ${durationSeconds.toFixed(2)}s`);
  console.log(`  Records/second: ${result.records_per_second.toFixed(1)}`);
  console.log(`  Avg batch latency: ${result.avg_batch_latency_ms.toFixed(0)}ms`);
  console.log(`  P95 batch latency: ${result.p95_batch_latency_ms.toFixed(0)}ms`);

  // Clean up benchmark records
  console.log("\nCleaning up benchmark records...");
  // Note: We don't delete them here as that would interfere with indexing benchmarks
  // Users can run delete command separately if needed

  // Save results to JSON
  const output = {
    timestamp: new Date().toISOString(),
    backend: options.backendName,
    config: {
      namespace,
      dimensions,
      total_records: totalRecords,
      batch_size: batchSize,
    },
    results: {
      backend: result.backend,
      namespace: result.namespace,
      dimensions: result.dimensions,
      total_records: result.total_records,
      batch_size: result.batch_size,
      num_batches: result.num_batches,
      duration_seconds: Math.round(result.duration_seconds * 1000) / 1000,
      records_per_second: Math.round(result.records_per_second * 10) / 10,
      avg_batch_latency_ms: Math.round(result.avg_batch_latency_ms),
      p95_batch_latency_ms: Math.round(result.p95_batch_latency_ms),
      batch_latencies_ms: result.batch_latencies_ms.map(l => Math.round(l)),
    },
  };

  const outputPath = options.output ??
    `data/upsert-benchmark-${options.backendName}-${namespace}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await Bun.write(outputPath, JSON.stringify(output, null, 2));
  console.log(`Results saved to: ${outputPath}`);

  return result;
}
