import Turbopuffer from "@turbopuffer/turbopuffer";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { DATA_DIR, NAMESPACES, type Namespace } from "./download.js";

const tpuf = new Turbopuffer({
  apiKey: process.env.TURBOPUFFER_API_KEY!,
});

const DEFAULT_TOP_K_VALUES = [1, 5, 10, 20, 50, 100];
const DEFAULT_NUM = 20;
const DEFAULT_RUNS = 20;
const DELAY_MS = 150;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export interface RecallRun {
  namespace: string;
  top_k: number;
  run: number;
  avg_recall: number;
  avg_ann_count: number;
  avg_exhaustive_count: number;
  latency_ms: number;
}

export interface ConfigSummary {
  namespace: string;
  top_k: number;
  runs: number;
  recall: {
    mean: number;
    std: number;
    ci95_lower: number;
    ci95_upper: number;
    min: number;
    max: number;
    median: number;
  };
  avg_ann_count: { mean: number; std: number };
  avg_exhaustive_count: { mean: number; std: number };
  latency_ms: { mean: number; std: number; median: number };
}

export interface BenchmarkResult {
  metadata: {
    timestamp: string;
    num: number;
    runs_per_config: number;
    top_k_values: number[];
    namespaces: string[];
    total_calls: number;
  };
  raw_runs: RecallRun[];
  summaries: ConfigSummary[];
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ci95(values: number[]): [number, number] {
  const m = mean(values);
  const se = std(values) / Math.sqrt(values.length);
  // t-critical value for 95% CI with df=19 is ~2.093, use 1.96 for large samples
  const t = values.length >= 30 ? 1.96 : 2.093;
  return [m - t * se, m + t * se];
}

function summarize(runs: RecallRun[]): ConfigSummary {
  const recalls = runs.map((r) => r.avg_recall);
  const annCounts = runs.map((r) => r.avg_ann_count);
  const exhCounts = runs.map((r) => r.avg_exhaustive_count);
  const latencies = runs.map((r) => r.latency_ms);
  const [ci_lower, ci_upper] = ci95(recalls);

  return {
    namespace: runs[0].namespace,
    top_k: runs[0].top_k,
    runs: runs.length,
    recall: {
      mean: mean(recalls),
      std: std(recalls),
      ci95_lower: ci_lower,
      ci95_upper: ci_upper,
      min: Math.min(...recalls),
      max: Math.max(...recalls),
      median: median(recalls),
    },
    avg_ann_count: { mean: mean(annCounts), std: std(annCounts) },
    avg_exhaustive_count: { mean: mean(exhCounts), std: std(exhCounts) },
    latency_ms: { mean: mean(latencies), std: std(latencies), median: median(latencies) },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BenchmarkOptions {
  runs?: number;
  num?: number;
  topK?: number[];
  namespaces?: Namespace[];
  output?: string;
}

const CHECKPOINT_PATH = join(DATA_DIR, "recall-benchmark-checkpoint.json");

interface Checkpoint {
  raw_runs: RecallRun[];
  completedConfigs: string[]; // "namespace:top_k" keys
}

function loadCheckpoint(): Checkpoint {
  if (existsSync(CHECKPOINT_PATH)) {
    try {
      const data = JSON.parse(
        require("fs").readFileSync(CHECKPOINT_PATH, "utf-8")
      );
      return {
        raw_runs: data.raw_runs ?? [],
        completedConfigs: data.completedConfigs ?? [],
      };
    } catch {
      // Corrupt checkpoint, start fresh
    }
  }
  return { raw_runs: [], completedConfigs: [] };
}

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await Bun.write(CHECKPOINT_PATH, JSON.stringify(checkpoint));
}

function removeCheckpoint(): void {
  try {
    require("fs").unlinkSync(CHECKPOINT_PATH);
  } catch {
    // Already gone
  }
}

function configKey(namespace: string, top_k: number): string {
  return `${namespace}:${top_k}`;
}

export async function runRecallBenchmark(options: BenchmarkOptions): Promise<void> {
  const runs = options.runs ?? DEFAULT_RUNS;
  const num = options.num ?? DEFAULT_NUM;
  const topKValues = options.topK ?? DEFAULT_TOP_K_VALUES;
  const namespaces = options.namespaces ?? [...NAMESPACES];

  const totalConfigs = namespaces.length * topKValues.length;
  const totalCalls = totalConfigs * runs;

  // Load checkpoint
  const checkpoint = loadCheckpoint();
  const skippedConfigs = checkpoint.completedConfigs.length;
  if (skippedConfigs > 0) {
    console.log(`\nResuming from checkpoint (${skippedConfigs}/${totalConfigs} configs completed)`);
  }

  console.log(`\nRecall Benchmark Configuration:`);
  console.log(`  Namespaces: ${namespaces.join(", ")}`);
  console.log(`  top_k values: ${topKValues.join(", ")}`);
  console.log(`  Queries per call (num): ${num}`);
  console.log(`  Runs per config: ${runs}`);
  console.log(`  Total API calls: ${totalCalls}`);
  console.log(`  Delay between calls: ${DELAY_MS}ms`);
  console.log("─".repeat(60));

  const rawRuns: RecallRun[] = [...checkpoint.raw_runs];
  const completedConfigs = new Set(checkpoint.completedConfigs);
  let completed = skippedConfigs * runs;

  for (const namespace of namespaces) {
    const ns = tpuf.namespace(namespace);

    for (const top_k of topKValues) {
      const key = configKey(namespace, top_k);
      if (completedConfigs.has(key)) {
        continue;
      }

      for (let run = 0; run < runs; run++) {
        completed++;
        process.stdout.write(
          `\r  [${completed}/${totalCalls}] ${namespace} top_k=${top_k} run=${run + 1}/${runs}   `
        );

        let result: Awaited<ReturnType<typeof ns.recall>>;
        let latency: number;
        let attempt = 0;
        while (true) {
          try {
            const start = performance.now();
            result = await ns.recall({
              num,
              top_k,
              include_ground_truth: false,
            });
            latency = performance.now() - start;
            break;
          } catch (e) {
            const err = e as { status?: number; message?: string };
            const isRetryable = err.status !== undefined && err.status >= 500;
            if (isRetryable && attempt < MAX_RETRIES) {
              attempt++;
              const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
              process.stdout.write(
                `\r  [${completed}/${totalCalls}] ${namespace} top_k=${top_k} run=${run + 1}/${runs} — ${err.status} retry ${attempt}/${MAX_RETRIES}   `
              );
              await sleep(backoff);
              continue;
            }
            throw e;
          }
        }

        rawRuns.push({
          namespace,
          top_k,
          run: run + 1,
          avg_recall: result.avg_recall,
          avg_ann_count: result.avg_ann_count,
          avg_exhaustive_count: result.avg_exhaustive_count,
          latency_ms: Math.round(latency),
        });

        if (completed < totalCalls) {
          await sleep(DELAY_MS);
        }
      }

      // Checkpoint after each top_k config completes
      completedConfigs.add(key);
      await saveCheckpoint({
        raw_runs: rawRuns,
        completedConfigs: [...completedConfigs],
      });
    }
  }

  console.log("\n");

  // Compute summaries
  const summaries: ConfigSummary[] = [];
  for (const namespace of namespaces) {
    for (const top_k of topKValues) {
      const configRuns = rawRuns.filter(
        (r) => r.namespace === namespace && r.top_k === top_k
      );
      summaries.push(summarize(configRuns));
    }
  }

  // Print summary table
  console.log("Results Summary:");
  console.log("─".repeat(90));
  console.log(
    `${"Namespace".padEnd(15)} ${"top_k".padStart(6)} ${"Recall".padStart(8)} ${"± 95% CI".padStart(12)} ${"Std".padStart(8)} ${"ANN".padStart(8)} ${"Exh".padStart(8)} ${"Latency".padStart(10)}`
  );
  console.log("─".repeat(90));

  for (const s of summaries) {
    const ciRange = `[${s.recall.ci95_lower.toFixed(4)}, ${s.recall.ci95_upper.toFixed(4)}]`;
    console.log(
      `${s.namespace.padEnd(15)} ${String(s.top_k).padStart(6)} ${s.recall.mean.toFixed(4).padStart(8)} ${ciRange.padStart(12)} ${s.recall.std.toFixed(4).padStart(8)} ${s.avg_ann_count.mean.toFixed(1).padStart(8)} ${s.avg_exhaustive_count.mean.toFixed(1).padStart(8)} ${(s.latency_ms.mean.toFixed(0) + "ms").padStart(10)}`
    );
  }
  console.log("─".repeat(90));

  // Write final output
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = options.output
    ? join(options.output, "..")
    : join(import.meta.dir, "..", "data");
  const outputPath = options.output ?? join(outputDir, `recall-benchmark-${timestamp}.json`);

  await mkdir(outputDir, { recursive: true });

  const benchmarkResult: BenchmarkResult = {
    metadata: {
      timestamp: new Date().toISOString(),
      num,
      runs_per_config: runs,
      top_k_values: topKValues,
      namespaces,
      total_calls: totalCalls,
    },
    raw_runs: rawRuns,
    summaries,
  };

  await Bun.write(outputPath, JSON.stringify(benchmarkResult, null, 2));
  console.log(`\nResults written to: ${outputPath}`);

  // Clean up checkpoint after successful completion
  removeCheckpoint();
}
