import { NAMESPACES, type Namespace } from "./download";
import type { VectorBackend } from "./backend";

const DEFAULT_TOTAL_QUERIES = 500;
const DEFAULT_TOP_K = 10;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_WARMUP_QUERIES = 20;

export interface ThroughputBenchmarkOptions {
  backend: VectorBackend;
  backendName: string;
  namespaces?: Namespace[];
  totalQueries?: number;
  topK?: number;
  concurrency?: number;
  warmupQueries?: number;
  output?: string;
}

export interface ThroughputResult {
  backend: string;
  namespace: string;
  dimensions: number;
  concurrency: number;
  total_queries: number;
  duration_seconds: number;
  qps: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  errors: number;
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

function generateRandomVector(dimensions: number): number[] {
  const vector = new Array(dimensions).fill(0).map(() => Math.random() * 2 - 1);
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map(v => v / norm);
}

async function getRandomVector(
  backend: VectorBackend,
  namespace: Namespace
): Promise<{ vector: number[]; id: string } | null> {
  const ns = backend.namespace(namespace);
  const dimensions = DIMENSION_MAP[namespace];

  try {
    const stats = await ns.stats();
    if (!stats.approxRowCount || stats.approxRowCount === 0) {
      return null;
    }

    // Query with a random vector to get a real document with its vector
    const randomVector = generateRandomVector(dimensions);
    const result = await ns.query({
      vector: randomVector,
      topK: 1,
      includeVector: true,
    });

    if (result.length > 0 && result[0].vector) {
      return { vector: result[0].vector, id: result[0].id };
    }
  } catch {
    // Namespace doesn't exist or other error
  }
  return null;
}

async function benchmarkNamespace(
  backend: VectorBackend,
  backendName: string,
  namespace: Namespace,
  options: {
    totalQueries: number;
    topK: number;
    concurrency: number;
    warmupQueries: number;
  }
): Promise<ThroughputResult | null> {
  const ns = backend.namespace(namespace);

  // Get a sample vector from this namespace
  const sample = await getRandomVector(backend, namespace);
  if (!sample) {
    console.log(`  ${namespace}: Skipped (no data or can't get vector)`);
    return null;
  }

  const dimensions = sample.vector.length;
  console.log(`  ${namespace} (${dimensions}d): Running ${options.totalQueries} queries with concurrency ${options.concurrency}...`);

  // Warmup queries (serial to warm up connections)
  console.log(`    Warming up (${options.warmupQueries} queries)...`);
  for (let i = 0; i < options.warmupQueries; i++) {
    await ns.query({
      vector: sample.vector,
      topK: options.topK,
    });
  }

  // Concurrent queries
  const latencies: number[] = [];
  let errors = 0;
  let activeCount = 0;
  let completedCount = 0;

  const startTime = performance.now();

  const runQuery = async (): Promise<void> => {
    while (completedCount < options.totalQueries) {
      const queryIndex = completedCount++;
      if (queryIndex >= options.totalQueries) break;

      activeCount++;
      const queryStart = performance.now();

      try {
        await ns.query({
          vector: sample.vector,
          topK: options.topK,
        });
        const queryEnd = performance.now();
        latencies.push(queryEnd - queryStart);
      } catch {
        errors++;
      }

      activeCount--;
    }
  };

  // Start concurrent workers
  const workers = Array(options.concurrency).fill(null).map(() => runQuery());
  await Promise.all(workers);

  const endTime = performance.now();
  const durationSeconds = (endTime - startTime) / 1000;

  const result: ThroughputResult = {
    backend: backendName,
    namespace,
    dimensions,
    concurrency: options.concurrency,
    total_queries: latencies.length,
    duration_seconds: durationSeconds,
    qps: latencies.length / durationSeconds,
    avg_latency_ms: mean(latencies),
    p50_latency_ms: percentile(latencies, 50),
    p95_latency_ms: percentile(latencies, 95),
    p99_latency_ms: percentile(latencies, 99),
    errors,
  };

  console.log(`    QPS: ${result.qps.toFixed(1)}, Avg latency: ${result.avg_latency_ms.toFixed(0)}ms, P95: ${result.p95_latency_ms.toFixed(0)}ms, Errors: ${errors}`);

  return result;
}

export async function runThroughputBenchmark(options: ThroughputBenchmarkOptions): Promise<ThroughputResult[]> {
  const totalQueries = options.totalQueries ?? DEFAULT_TOTAL_QUERIES;
  const topK = options.topK ?? DEFAULT_TOP_K;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const warmupQueries = options.warmupQueries ?? DEFAULT_WARMUP_QUERIES;
  const namespaces = options.namespaces ?? [...NAMESPACES];

  console.log("Throughput Benchmark (QPS under load)");
  console.log("=====================================");
  console.log(`Backend: ${options.backendName}`);
  console.log(`Total queries: ${totalQueries}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`top_k: ${topK}`);
  console.log(`Warmup queries: ${warmupQueries}`);
  console.log("");

  const results: ThroughputResult[] = [];

  for (const namespace of namespaces) {
    const result = await benchmarkNamespace(
      options.backend,
      options.backendName,
      namespace,
      { totalQueries, topK, concurrency, warmupQueries }
    );
    if (result) {
      results.push(result);
    }
  }

  // Sort by QPS descending
  results.sort((a, b) => b.qps - a.qps);

  console.log("\n" + "=".repeat(100));
  console.log("RESULTS SUMMARY (sorted by QPS)");
  console.log("=".repeat(100));
  console.log("");
  console.log("| Namespace | Dims | QPS | Avg Lat | P50 | P95 | P99 | Errors |");
  console.log("|-----------|------|-----|---------|-----|-----|-----|--------|");

  for (const r of results) {
    console.log(
      `| ${r.namespace.padEnd(12)} | ${String(r.dimensions).padStart(4)} | ${r.qps.toFixed(1).padStart(5)} | ${r.avg_latency_ms.toFixed(0).padStart(5)}ms | ${r.p50_latency_ms.toFixed(0).padStart(3)}ms | ${r.p95_latency_ms.toFixed(0).padStart(3)}ms | ${r.p99_latency_ms.toFixed(0).padStart(3)}ms | ${String(r.errors).padStart(6)} |`
    );
  }

  // Save results to JSON
  const output = {
    timestamp: new Date().toISOString(),
    backend: options.backendName,
    config: {
      total_queries: totalQueries,
      top_k: topK,
      concurrency,
      warmup_queries: warmupQueries,
    },
    results: results.map(r => ({
      backend: r.backend,
      namespace: r.namespace,
      dimensions: r.dimensions,
      concurrency: r.concurrency,
      total_queries: r.total_queries,
      duration_seconds: Math.round(r.duration_seconds * 1000) / 1000,
      qps: Math.round(r.qps * 10) / 10,
      avg_latency_ms: Math.round(r.avg_latency_ms),
      p50_latency_ms: Math.round(r.p50_latency_ms),
      p95_latency_ms: Math.round(r.p95_latency_ms),
      p99_latency_ms: Math.round(r.p99_latency_ms),
      errors: r.errors,
    })),
  };

  const outputPath = options.output ??
    `data/throughput-benchmark-${options.backendName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await Bun.write(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);

  return results;
}
