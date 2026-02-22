import { NAMESPACES, type Namespace } from "./download";
import type { VectorBackend } from "./backend";

const DEFAULT_NUM_QUERIES = 50;
const DEFAULT_TOP_K = 10;
const DEFAULT_WARMUP_QUERIES = 5;
const DEFAULT_DELAY_MS = 50;

export interface LatencyBenchmarkOptions {
  backend: VectorBackend;
  backendName: string;
  namespaces?: Namespace[];
  numQueries?: number;
  topK?: number;
  warmupQueries?: number;
  delayMs?: number;
  output?: string;
}

export interface LatencyResult {
  backend: string;
  namespace: string;
  dimensions: number;
  latencies_ms: number[];
  mean_ms: number;
  median_ms: number;
  p95_ms: number;
  min_ms: number;
  max_ms: number;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(arr: number[]): number {
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
  } catch (e) {
    // Namespace doesn't exist or other error
    console.error(`  Error getting vector for ${namespace}:`, e);
  }
  return null;
}

async function benchmarkNamespace(
  backend: VectorBackend,
  backendName: string,
  namespace: Namespace,
  options: {
    numQueries: number;
    topK: number;
    warmupQueries: number;
    delayMs: number;
  }
): Promise<LatencyResult | null> {
  const ns = backend.namespace(namespace);

  // Get a sample vector from this namespace
  const sample = await getRandomVector(backend, namespace);
  if (!sample) {
    console.log(`  ${namespace}: Skipped (no data or can't get vector)`);
    return null;
  }

  const dimensions = sample.vector.length;
  console.log(`  ${namespace} (${dimensions}d): Running ${options.numQueries} queries...`);

  // Warmup queries (not counted)
  for (let i = 0; i < options.warmupQueries; i++) {
    await ns.query({
      vector: sample.vector,
      topK: options.topK,
    });
  }

  // Timed queries
  const latencies: number[] = [];
  for (let i = 0; i < options.numQueries; i++) {
    const start = performance.now();
    await ns.query({
      vector: sample.vector,
      topK: options.topK,
    });
    const elapsed = performance.now() - start;
    latencies.push(elapsed);

    // Small delay to avoid hammering the API
    if (options.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, options.delayMs));
    }
  }

  const result: LatencyResult = {
    backend: backendName,
    namespace,
    dimensions,
    latencies_ms: latencies,
    mean_ms: mean(latencies),
    median_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    min_ms: Math.min(...latencies),
    max_ms: Math.max(...latencies),
  };

  console.log(`    Mean: ${result.mean_ms.toFixed(0)}ms, Median: ${result.median_ms.toFixed(0)}ms, P95: ${result.p95_ms.toFixed(0)}ms`);

  return result;
}

export async function runLatencyBenchmark(options: LatencyBenchmarkOptions): Promise<LatencyResult[]> {
  const numQueries = options.numQueries ?? DEFAULT_NUM_QUERIES;
  const topK = options.topK ?? DEFAULT_TOP_K;
  const warmupQueries = options.warmupQueries ?? DEFAULT_WARMUP_QUERIES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const namespaces = options.namespaces ?? [...NAMESPACES];

  console.log("Single-Query Latency Benchmark");
  console.log("==============================");
  console.log(`Backend: ${options.backendName}`);
  console.log(`Queries per namespace: ${numQueries}`);
  console.log(`top_k: ${topK}`);
  console.log(`Warmup queries: ${warmupQueries}`);
  console.log("");

  const results: LatencyResult[] = [];

  for (const namespace of namespaces) {
    const result = await benchmarkNamespace(
      options.backend,
      options.backendName,
      namespace,
      { numQueries, topK, warmupQueries, delayMs }
    );
    if (result) {
      results.push(result);
    }
  }

  // Sort by median latency
  results.sort((a, b) => a.median_ms - b.median_ms);

  console.log("\n" + "=".repeat(80));
  console.log("RESULTS SUMMARY (sorted by median latency)");
  console.log("=".repeat(80));
  console.log("");
  console.log("| Namespace | Dims | Mean | Median | P95 | Min | Max |");
  console.log("|-----------|------|------|--------|-----|-----|-----|");

  for (const r of results) {
    console.log(
      `| ${r.namespace.padEnd(12)} | ${String(r.dimensions).padStart(4)} | ${r.mean_ms.toFixed(0).padStart(4)}ms | ${r.median_ms.toFixed(0).padStart(6)}ms | ${r.p95_ms.toFixed(0).padStart(3)}ms | ${r.min_ms.toFixed(0).padStart(3)}ms | ${r.max_ms.toFixed(0).padStart(3)}ms |`
    );
  }

  // Save results to JSON
  const output = {
    timestamp: new Date().toISOString(),
    backend: options.backendName,
    config: {
      num_queries: numQueries,
      top_k: topK,
      warmup_queries: warmupQueries,
      delay_ms: delayMs,
    },
    results: results.map(r => ({
      backend: r.backend,
      namespace: r.namespace,
      dimensions: r.dimensions,
      mean_ms: Math.round(r.mean_ms),
      median_ms: Math.round(r.median_ms),
      p95_ms: Math.round(r.p95_ms),
      min_ms: Math.round(r.min_ms),
      max_ms: Math.round(r.max_ms),
      latencies_ms: r.latencies_ms.map(l => Math.round(l)),
    })),
  };

  const outputPath = options.output ??
    `data/latency-benchmark-${options.backendName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await Bun.write(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);

  return results;
}
