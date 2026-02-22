import { program } from "commander";
import { downloadDatasets, NAMESPACES, type Namespace } from "./download";
import { seed } from "./seed";
import { getStats, queryByDocId, deleteNamespaces } from "./query";
import { createBackend, type BackendType } from "./backend";
import { embedDataset, type EmbeddingModel } from "./embed";

const VALID_BACKENDS = ["tpuf", "pinecone", "supabase"];

program
  .name("wiki-seed")
  .description("Seed and benchmark vector databases with Wikipedia datasets")
  .version("1.0.0")
  .option("--backend <backend>", `Vector backend (${VALID_BACKENDS.join(", ")})`, "tpuf");

program
  .command("download")
  .description("Download ndjson.gz files from Hugging Face")
  .action(async () => {
    await downloadDatasets();
  });

program
  .command("seed")
  .description("Seed data into vector namespaces")
  .option("-n, --namespace <namespace>", "Seed only one namespace")
  .option("-l, --limit <number>", "Limit records per namespace", parseInt)
  .option("-b, --batch-size <number>", "Batch size for upserts", parseInt, 256)
  .option("-c, --concurrency <number>", "Concurrent upsert requests", parseInt, 3)
  .action(async (options) => {
    if (options.namespace && !NAMESPACES.includes(options.namespace as Namespace)) {
      console.error(`Invalid namespace: ${options.namespace}`);
      console.error(`Valid namespaces: ${NAMESPACES.join(", ")}`);
      process.exit(1);
    }
    const globalOpts = program.opts();
    const backend = await createBackend(globalOpts.backend as BackendType);
    await seed({
      namespace: options.namespace as Namespace | undefined,
      limit: options.limit,
      batchSize: options.batchSize,
      concurrency: options.concurrency,
      backend,
    });
  });

program
  .command("stats")
  .description("Show namespace statistics")
  .action(async () => {
    const globalOpts = program.opts();
    const backend = await createBackend(globalOpts.backend as BackendType);
    await getStats(backend);
  });

program
  .command("query")
  .description("Query namespaces using a document's vector")
  .requiredOption("-d, --doc-id <id>", "Document ID to use as query source")
  .option("-k, --top-k <number>", "Number of results per namespace", parseInt, 10)
  .action(async (options) => {
    const globalOpts = program.opts();
    const backend = await createBackend(globalOpts.backend as BackendType);
    await queryByDocId(backend, options.docId, options.topK);
  });

program
  .command("delete")
  .description("Delete wiki-* namespaces")
  .option("-n, --namespace <namespace>", "Delete only one namespace")
  .option("--confirm", "Actually delete (required)")
  .action(async (options) => {
    if (options.namespace && !NAMESPACES.includes(options.namespace as Namespace)) {
      console.error(`Invalid namespace: ${options.namespace}`);
      console.error(`Valid namespaces: ${NAMESPACES.join(", ")}`);
      process.exit(1);
    }
    const globalOpts = program.opts();
    const backend = await createBackend(globalOpts.backend as BackendType);
    await deleteNamespaces(backend, options.confirm, options.namespace as Namespace | undefined);
  });

program
  .command("embed")
  .description("Embed text using OpenAI embedding models")
  .requiredOption("-m, --model <model>", "OpenAI model (text-embedding-3-small or text-embedding-3-large)")
  .option("-s, --source <namespace>", "Source namespace for text", "wiki-openai")
  .option("-l, --limit <number>", "Max records to embed", parseInt)
  .option("-b, --batch-size <number>", "Texts per API call", parseInt, 100)
  .option("-c, --concurrency <number>", "Concurrent API calls", parseInt, 1)
  .action(async (options) => {
    const validModels = ["text-embedding-3-small", "text-embedding-3-large"];
    if (!validModels.includes(options.model)) {
      console.error(`Invalid model: ${options.model}`);
      console.error(`Valid models: ${validModels.join(", ")}`);
      process.exit(1);
    }
    if (!NAMESPACES.includes(options.source as Namespace)) {
      console.error(`Invalid source namespace: ${options.source}`);
      console.error(`Valid namespaces: ${NAMESPACES.join(", ")}`);
      process.exit(1);
    }
    await embedDataset({
      model: options.model as EmbeddingModel,
      sourceNamespace: options.source as Namespace,
      limit: options.limit,
      batchSize: options.batchSize,
      concurrency: options.concurrency,
    });
  });

program
  .command("recall-benchmark")
  .description("Run recall benchmarks across namespaces and top_k values")
  .option("-r, --runs <number>", "Number of runs per configuration", parseInt, 20)
  .option("-n, --num <number>", "Number of queries per recall call", parseInt, 20)
  .option(
    "-k, --top-k <values>",
    "Comma-separated top_k values",
    (val: string) => val.split(",").map(Number)
  )
  .option(
    "--namespace <namespaces>",
    "Comma-separated namespace names",
    (val: string) => val.split(",") as Namespace[]
  )
  .option("-o, --output <path>", "Output file path for JSON results")
  .action(async (options) => {
    const globalOpts = program.opts();
    if (globalOpts.backend !== "tpuf") {
      console.error("recall-benchmark is only supported with the tpuf backend (uses Turbopuffer's recall API).");
      process.exit(1);
    }
    if (options.namespace) {
      for (const ns of options.namespace) {
        if (!NAMESPACES.includes(ns as Namespace)) {
          console.error(`Invalid namespace: ${ns}`);
          console.error(`Valid namespaces: ${NAMESPACES.join(", ")}`);
          process.exit(1);
        }
      }
    }
    const { runRecallBenchmark } = await import("./recall-benchmark");
    await runRecallBenchmark({
      runs: options.runs,
      num: options.num,
      topK: options.topK,
      namespaces: options.namespace,
      output: options.output,
    });
  });

program
  .command("latency-benchmark")
  .description("Run single-query latency benchmarks")
  .option("-q, --queries <number>", "Number of queries per namespace", parseInt, 50)
  .option("-k, --top-k <number>", "Number of results per query", parseInt, 10)
  .option("-w, --warmup <number>", "Warmup queries before timing", parseInt, 5)
  .option("-d, --delay <number>", "Delay between queries (ms)", parseInt, 50)
  .option(
    "--namespace <namespaces>",
    "Comma-separated namespace names",
    (val: string) => val.split(",") as Namespace[]
  )
  .option("-o, --output <path>", "Output file path for JSON results")
  .action(async (options) => {
    const globalOpts = program.opts();
    if (!VALID_BACKENDS.includes(globalOpts.backend)) {
      console.error(`Invalid backend: ${globalOpts.backend}`);
      console.error(`Valid backends: ${VALID_BACKENDS.join(", ")}`);
      process.exit(1);
    }
    if (options.namespace) {
      for (const ns of options.namespace) {
        if (!NAMESPACES.includes(ns as Namespace)) {
          console.error(`Invalid namespace: ${ns}`);
          console.error(`Valid namespaces: ${NAMESPACES.join(", ")}`);
          process.exit(1);
        }
      }
    }
    const backend = await createBackend(globalOpts.backend as BackendType);
    const { runLatencyBenchmark } = await import("./latency-benchmark");
    await runLatencyBenchmark({
      backend,
      backendName: globalOpts.backend,
      namespaces: options.namespace,
      numQueries: options.queries,
      topK: options.topK,
      warmupQueries: options.warmup,
      delayMs: options.delay,
      output: options.output,
    });
  });

program
  .command("throughput-benchmark")
  .description("Run throughput benchmarks (QPS under load)")
  .option("-q, --queries <number>", "Total queries to run", parseInt, 500)
  .option("-c, --concurrency <number>", "Concurrent queries", parseInt, 10)
  .option("-k, --top-k <number>", "Number of results per query", parseInt, 10)
  .option("-w, --warmup <number>", "Warmup queries before timing", parseInt, 20)
  .option(
    "--namespace <namespaces>",
    "Comma-separated namespace names",
    (val: string) => val.split(",") as Namespace[]
  )
  .option("-o, --output <path>", "Output file path for JSON results")
  .action(async (options) => {
    const globalOpts = program.opts();
    if (!VALID_BACKENDS.includes(globalOpts.backend)) {
      console.error(`Invalid backend: ${globalOpts.backend}`);
      console.error(`Valid backends: ${VALID_BACKENDS.join(", ")}`);
      process.exit(1);
    }
    if (options.namespace) {
      for (const ns of options.namespace) {
        if (!NAMESPACES.includes(ns as Namespace)) {
          console.error(`Invalid namespace: ${ns}`);
          console.error(`Valid namespaces: ${NAMESPACES.join(", ")}`);
          process.exit(1);
        }
      }
    }
    const backend = await createBackend(globalOpts.backend as BackendType);
    const { runThroughputBenchmark } = await import("./throughput-benchmark");
    await runThroughputBenchmark({
      backend,
      backendName: globalOpts.backend,
      namespaces: options.namespace,
      totalQueries: options.queries,
      topK: options.topK,
      concurrency: options.concurrency,
      warmupQueries: options.warmup,
      output: options.output,
    });
  });

program
  .command("upsert-benchmark")
  .description("Run upsert/write performance benchmarks")
  .requiredOption("-n, --namespace <namespace>", "Namespace to benchmark")
  .option("-r, --records <number>", "Total records to upsert", parseInt, 10000)
  .option("-b, --batch-size <number>", "Batch size for upserts", parseInt, 256)
  .option("-o, --output <path>", "Output file path for JSON results")
  .action(async (options) => {
    const globalOpts = program.opts();
    if (!VALID_BACKENDS.includes(globalOpts.backend)) {
      console.error(`Invalid backend: ${globalOpts.backend}`);
      console.error(`Valid backends: ${VALID_BACKENDS.join(", ")}`);
      process.exit(1);
    }
    if (!NAMESPACES.includes(options.namespace as Namespace)) {
      console.error(`Invalid namespace: ${options.namespace}`);
      console.error(`Valid namespaces: ${NAMESPACES.join(", ")}`);
      process.exit(1);
    }
    const backend = await createBackend(globalOpts.backend as BackendType);
    const { runUpsertBenchmark } = await import("./upsert-benchmark");
    await runUpsertBenchmark({
      backend,
      backendName: globalOpts.backend,
      namespace: options.namespace as Namespace,
      totalRecords: options.records,
      batchSize: options.batchSize,
      output: options.output,
    });
  });

program
  .command("cost-estimate")
  .description("Estimate monthly costs across backends")
  .option("-v, --vectors <number>", "Number of vectors", parseInt)
  .option("-d, --dimensions <number>", "Vector dimensions", parseInt)
  .option("-q, --queries <number>", "Queries per month", parseInt)
  .option("-w, --writes <number>", "Writes per month", parseInt)
  .option("-o, --output <path>", "Output file path for JSON results")
  .action(async (options) => {
    const { printCostComparison, generateCostReport, SCENARIOS, estimateAllBackends } = await import("./cost-calculator");

    if (options.vectors && options.dimensions) {
      // Custom scenario
      const customScenario = {
        name: "Custom",
        vectors: options.vectors,
        dimensions: options.dimensions,
        queries_per_month: options.queries || 100_000,
        writes_per_month: options.writes || 1_000,
      };
      console.log("Custom Cost Estimate");
      console.log("====================");
      console.log(`Vectors: ${customScenario.vectors.toLocaleString()}`);
      console.log(`Dimensions: ${customScenario.dimensions}`);
      console.log(`Queries/month: ${customScenario.queries_per_month.toLocaleString()}`);
      console.log(`Writes/month: ${customScenario.writes_per_month.toLocaleString()}`);
      console.log("");

      const estimates = estimateAllBackends(customScenario);
      estimates.sort((a: { total_monthly_cost: number }, b: { total_monthly_cost: number }) => a.total_monthly_cost - b.total_monthly_cost);

      console.log("| Backend | Storage | Monthly Cost | Notes |");
      console.log("|---------|---------|--------------|-------|");

      for (const e of estimates) {
        const cost = e.total_monthly_cost < 1
          ? "Free tier"
          : `$${e.total_monthly_cost.toFixed(0)}`;
        console.log(
          `| ${e.backend.padEnd(10)} | ${e.storage_gb.toFixed(1)}GB | ${cost.padStart(12)} | ${e.notes[0]} |`
        );
      }

      if (options.output) {
        const report = {
          generated_at: new Date().toISOString(),
          scenario: customScenario,
          estimates,
        };
        await Bun.write(options.output, JSON.stringify(report, null, 2));
        console.log(`\nResults saved to: ${options.output}`);
      }
    } else {
      // All predefined scenarios
      printCostComparison(SCENARIOS);

      if (options.output) {
        const report = generateCostReport();
        await Bun.write(options.output, JSON.stringify(report, null, 2));
        console.log(`\nResults saved to: ${options.output}`);
      }
    }
  });

program
  .command("supabase-sql")
  .description("Generate SQL for Supabase/pgvector setup")
  .action(async () => {
    const { generateSupabaseSQL } = await import("./backend-supabase");
    console.log(generateSupabaseSQL());
  });

program.parse();
