export type CostBackend = "tpuf" | "pinecone" | "elastic" | "opensearch" | "supabase";

export interface UsageScenario {
  name: string;
  vectors: number;
  dimensions: number;
  queries_per_month: number;
  writes_per_month: number;
}

export interface CostEstimate {
  backend: CostBackend;
  scenario: string;
  storage_gb: number;
  storage_cost: number;
  query_cost: number;
  write_cost: number;
  compute_cost: number;
  minimum_cost: number;
  total_monthly_cost: number;
  notes: string[];
}

// Predefined usage scenarios
export const SCENARIOS: UsageScenario[] = [
  {
    name: "Small",
    vectors: 100_000,
    dimensions: 384,
    queries_per_month: 100_000,
    writes_per_month: 1_000,
  },
  {
    name: "Medium",
    vectors: 1_000_000,
    dimensions: 512,
    queries_per_month: 1_000_000,
    writes_per_month: 10_000,
  },
  {
    name: "Large",
    vectors: 10_000_000,
    dimensions: 1024,
    queries_per_month: 10_000_000,
    writes_per_month: 100_000,
  },
  {
    name: "Enterprise",
    vectors: 100_000_000,
    dimensions: 1536,
    queries_per_month: 100_000_000,
    writes_per_month: 1_000_000,
  },
];

// Storage calculation: vectors * dimensions * 4 bytes (float32) + metadata overhead
function calculateStorageGB(vectors: number, dimensions: number): number {
  const vectorBytes = vectors * dimensions * 4;
  const metadataBytes = vectors * 1000; // ~1KB metadata per vector (title, text truncated)
  const indexOverhead = 1.5; // Index typically adds 50% overhead
  return (vectorBytes + metadataBytes) * indexOverhead / (1024 ** 3);
}

// Turbopuffer pricing (as of Feb 2026)
// See: https://turbopuffer.com/pricing and https://turbopuffer.com/docs/pricing-log
// - Usage-based: billed on logical bytes stored, queried, and written
// - $64/month minimum (Launch plan)
// - Storage: $0.30/GB/month (logical bytes)
// - Queries: $1/PB base rate for data queried + data returned
//   - Minimum 1.28 GB billed per query
//   - 80% marginal discount on data queried between 32 GB and 128 GB
//   - 96% marginal discount on data queried beyond 128 GB
// - Writes: ~$0.02 per 1000 writes (estimated, batch discounts up to 50%)
function estimateTurbopuffer(scenario: UsageScenario): CostEstimate {
  const storage_gb = calculateStorageGB(scenario.vectors, scenario.dimensions);
  const storage_cost = storage_gb * 0.30;

  // Query cost: $1/PB = $0.000001/GB, minimum 1.28 GB per query
  const min_query_gb = 1.28;
  const data_queried_per_query_gb = Math.max(storage_gb, min_query_gb);
  const rate_per_gb = 1 / 1_000_000; // $1/PB

  // Apply tiered discounts for data queried per query
  let per_query_cost: number;
  if (data_queried_per_query_gb <= 32) {
    per_query_cost = data_queried_per_query_gb * rate_per_gb;
  } else if (data_queried_per_query_gb <= 128) {
    per_query_cost =
      32 * rate_per_gb +
      (data_queried_per_query_gb - 32) * rate_per_gb * 0.2; // 80% discount
  } else {
    per_query_cost =
      32 * rate_per_gb +
      96 * rate_per_gb * 0.2 + // 32-128 GB at 80% discount
      (data_queried_per_query_gb - 128) * rate_per_gb * 0.04; // 96% discount
  }

  const query_cost = per_query_cost * scenario.queries_per_month;
  const write_cost = (scenario.writes_per_month / 1000) * 0.02;
  const minimum_cost = 64;

  const usage_total = storage_cost + query_cost + write_cost;
  const total = Math.max(usage_total, minimum_cost);

  return {
    backend: "tpuf",
    scenario: scenario.name,
    storage_gb,
    storage_cost,
    query_cost,
    write_cost,
    compute_cost: 0,
    minimum_cost,
    total_monthly_cost: total,
    notes: [
      "Usage-based pricing (logical bytes)",
      "$64/month minimum (Launch plan)",
      "Query discounts at 32GB+ and 128GB+",
    ],
  };
}

// Pinecone pricing (Serverless, as of 2026)
// See: https://www.pinecone.io/pricing/ and https://docs.pinecone.io/guides/costs/understanding-cost
// - Standard: $50/month minimum
// - Storage: $0.33/GB/month
// - Read units: $16 per 1M RU
//   - IMPORTANT: 1 RU per GB of namespace size per query (min 0.25 RU/query)
//   - This means query cost scales with namespace size, not just query count
// - Write units: $4 per 1M WU
function estimatePinecone(scenario: UsageScenario): CostEstimate {
  const storage_gb = calculateStorageGB(scenario.vectors, scenario.dimensions);

  const storage_cost = storage_gb * 0.33;

  // Read units scale with namespace size: 1 RU per GB per query, min 0.25 RU
  const ru_per_query = Math.max(Math.ceil(storage_gb), 1);
  const total_ru = scenario.queries_per_month * ru_per_query;
  const query_cost = (total_ru / 1_000_000) * 16; // $16/M RU

  const write_cost = (scenario.writes_per_month / 1_000_000) * 4; // $4/M WU

  const usage_total = storage_cost + query_cost + write_cost;
  const minimum_cost = 50;
  const total = Math.max(usage_total, minimum_cost);

  return {
    backend: "pinecone",
    scenario: scenario.name,
    storage_gb,
    storage_cost,
    query_cost,
    write_cost,
    compute_cost: 0,
    minimum_cost,
    total_monthly_cost: total,
    notes: [
      "Standard plan ($50 min)",
      `${ru_per_query} RU/query (1 RU per GB namespace)`,
      "Storage: $0.33/GB, Reads: $16/M RU, Writes: $4/M WU",
    ],
  };
}

// Elasticsearch (Elastic Cloud Serverless, as of 2026)
// See: https://www.elastic.co/pricing/serverless-search
// - Search VCU: $0.09/VCU-hour
// - Ingest VCU: $0.14/VCU-hour
// - Storage: $0.047/GB/month (50GB free for vector profiles)
// - Minimum ~2 VCU baseline
// - Vector search uses "Vector Optimized" profile (~4x more VCUs than text)
// - VCUs must hold HNSW index in memory (~8GB usable per VCU)
function estimateElasticsearch(scenario: UsageScenario): CostEstimate {
  const storage_gb = calculateStorageGB(scenario.vectors, scenario.dimensions);

  const free_storage_gb = 50;
  const billable_storage = Math.max(0, storage_gb - free_storage_gb);
  const storage_cost = billable_storage * 0.047;

  const hours_per_month = 24 * 30;

  // HNSW index must fit in aggregate VCU memory for low-latency vector search
  // Memory per vector: vector data + HNSW graph edges (M=16, ~256 bytes overhead)
  const bytes_per_vector = scenario.dimensions * 4 + 256;
  const index_memory_gb = (scenario.vectors * bytes_per_vector) / (1024 ** 3);
  const gb_per_vcu = 8; // ~8GB usable memory per VCU
  const data_driven_search_vcus = index_memory_gb / gb_per_vcu;

  // Query-throughput-driven VCUs
  const queries_per_hour = scenario.queries_per_month / hours_per_month;
  const throughput_search_vcus = queries_per_hour / 2_500;

  // Ingest VCUs
  const writes_per_hour = scenario.writes_per_month / hours_per_month;
  const write_vcus_needed = writes_per_hour / 10_000;

  const min_search_vcus = 1;
  const min_ingest_vcus = 1;
  // Search VCUs: max of data-driven (index must fit) and throughput-driven
  const search_vcus = Math.max(data_driven_search_vcus, throughput_search_vcus, min_search_vcus);
  const ingest_vcus = Math.max(write_vcus_needed, min_ingest_vcus);

  const search_cost = search_vcus * hours_per_month * 0.09;
  const ingest_cost = ingest_vcus * hours_per_month * 0.14;
  const compute_cost = search_cost + ingest_cost;
  const min_compute = (min_search_vcus * 0.09 + min_ingest_vcus * 0.14) * hours_per_month;

  return {
    backend: "elastic",
    scenario: scenario.name,
    storage_gb,
    storage_cost,
    query_cost: 0,
    write_cost: 0,
    compute_cost,
    minimum_cost: min_compute,
    total_monthly_cost: storage_cost + compute_cost,
    notes: [
      "VCU-based serverless pricing",
      `~${Math.ceil(search_vcus)} search VCUs (index must fit in memory)`,
      "Search: $0.09/VCU-hr, Ingest: $0.14/VCU-hr",
    ],
  };
}

// AWS OpenSearch Serverless (AOSS, as of 2026)
// See: https://aws.amazon.com/opensearch-service/pricing/
// - $0.24/OCU-hour
// - Storage: $0.024/GB/month
// - Minimum 2 OCUs (1 search + 1 indexing) for production
// - Each OCU provides ~6GB of memory for hot data
// - HNSW vector indexes must fit in aggregate OCU memory
function estimateOpenSearch(scenario: UsageScenario): CostEstimate {
  const storage_gb = calculateStorageGB(scenario.vectors, scenario.dimensions);
  const storage_cost = storage_gb * 0.024;

  const hours_per_month = 24 * 30;

  // HNSW index must fit in aggregate OCU memory
  // Memory per vector: vector data + HNSW graph edges (~256 bytes for M=16)
  const bytes_per_vector = scenario.dimensions * 4 + 256;
  const index_memory_gb = (scenario.vectors * bytes_per_vector) / (1024 ** 3);
  const gb_per_ocu = 6; // ~6GB usable memory per search OCU
  const data_driven_search_ocu = index_memory_gb / gb_per_ocu;

  // Query-throughput-driven OCUs
  const queries_per_hour = scenario.queries_per_month / hours_per_month;
  const throughput_search_ocu = queries_per_hour / 10_000;

  // Indexing OCUs
  const indexing_ocu = Math.max(1, scenario.writes_per_month / (50_000 * hours_per_month));

  // Search OCUs: max of data-driven and throughput-driven
  const search_ocu = Math.max(data_driven_search_ocu, throughput_search_ocu, 1);
  const total_ocu = search_ocu + indexing_ocu;
  const min_ocu = 2;
  const effective_ocu = Math.max(total_ocu, min_ocu);

  const compute_cost = effective_ocu * hours_per_month * 0.24;

  return {
    backend: "opensearch",
    scenario: scenario.name,
    storage_gb,
    storage_cost,
    query_cost: 0,
    write_cost: 0,
    compute_cost,
    minimum_cost: min_ocu * hours_per_month * 0.24,
    total_monthly_cost: storage_cost + compute_cost,
    notes: [
      "OCU-based serverless pricing",
      `~${Math.ceil(search_ocu)} search OCUs (index must fit in memory)`,
      "$0.24/OCU-hr, $0.024/GB storage",
    ],
  };
}

// Supabase/pgvector pricing (as of 2026)
// See: https://supabase.com/pricing and https://supabase.com/docs/guides/ai/choosing-compute-addon
// - Pro: $25/month base, 8GB storage included
// - Storage overage: $0.125/GB/month
// - No per-query charges, but compute add-ons required for vector workloads
// - Compute add-ons are the dominant cost for pgvector (HNSW needs RAM)
function estimateSupabase(scenario: UsageScenario): CostEstimate {
  const storage_gb = calculateStorageGB(scenario.vectors, scenario.dimensions);

  // Pro plan base
  const base_cost = 25;
  const included_storage = 8;

  const extra_storage = Math.max(0, storage_gb - included_storage);
  const storage_cost = extra_storage * 0.125;

  // Compute add-on based on vector count (HNSW index must fit in RAM)
  // Tiers from https://supabase.com/docs/guides/ai/choosing-compute-addon
  const compute_tiers = [
    { name: "Micro",  maxVectors384: 100_000,   maxVectors1536: 15_000,    cost: 10 },
    { name: "Small",  maxVectors384: 250_000,   maxVectors1536: 50_000,    cost: 15 },
    { name: "Medium", maxVectors384: 500_000,   maxVectors1536: 100_000,   cost: 60 },
    { name: "Large",  maxVectors384: 1_000_000, maxVectors1536: 224_000,   cost: 110 },
    { name: "XL",     maxVectors384: 2_000_000, maxVectors1536: 500_000,   cost: 210 },
    { name: "2XL",    maxVectors384: 4_000_000, maxVectors1536: 1_000_000, cost: 410 },
    { name: "4XL",    maxVectors384: 8_000_000, maxVectors1536: 2_000_000, cost: 960 },
    { name: "8XL",    maxVectors384: 16_000_000, maxVectors1536: 4_000_000, cost: 1870 },
    { name: "12XL",   maxVectors384: 24_000_000, maxVectors1536: 6_000_000, cost: 2800 },
    { name: "16XL",   maxVectors384: 32_000_000, maxVectors1536: 8_000_000, cost: 3730 },
  ];

  // Interpolate max vectors based on dimensions (384 and 1536 are reference points)
  const dimRatio = Math.min(1, Math.max(0, (scenario.dimensions - 384) / (1536 - 384)));

  let compute_cost = 0;
  let tier_name = "Micro";

  const matchedTier = compute_tiers.find(t => {
    const maxVectors = Math.round(t.maxVectors384 + (t.maxVectors1536 - t.maxVectors384) * dimRatio);
    return scenario.vectors <= maxVectors;
  });

  if (matchedTier) {
    compute_cost = matchedTier.cost;
    tier_name = matchedTier.name;
  } else {
    // Exceeds largest tier — extrapolate linearly from 16XL
    const largest = compute_tiers[compute_tiers.length - 1];
    const maxVectors = Math.round(largest.maxVectors384 + (largest.maxVectors1536 - largest.maxVectors384) * dimRatio);
    const multiplier = Math.ceil(scenario.vectors / maxVectors);
    compute_cost = largest.cost * multiplier;
    tier_name = `${multiplier}x 16XL`;
  }

  return {
    backend: "supabase",
    scenario: scenario.name,
    storage_gb,
    storage_cost,
    query_cost: 0,
    write_cost: 0,
    compute_cost,
    minimum_cost: base_cost,
    total_monthly_cost: base_cost + storage_cost + compute_cost,
    notes: [
      `Pro + ${tier_name} compute ($${compute_cost}/mo)`,
      "No per-query charges (compute-bound)",
      "Storage: $0.125/GB over 8GB included",
    ],
  };
}

export function estimateCost(backend: CostBackend, scenario: UsageScenario): CostEstimate {
  switch (backend) {
    case "tpuf":
      return estimateTurbopuffer(scenario);
    case "pinecone":
      return estimatePinecone(scenario);
    case "elastic":
      return estimateElasticsearch(scenario);
    case "opensearch":
      return estimateOpenSearch(scenario);
    case "supabase":
      return estimateSupabase(scenario);
    default:
      throw new Error(`Unknown backend: ${backend}`);
  }
}

export function estimateAllBackends(scenario: UsageScenario): CostEstimate[] {
  const backends: CostBackend[] = ["tpuf", "pinecone", "elastic", "opensearch", "supabase"];
  return backends.map(b => estimateCost(b, scenario));
}

export function printCostComparison(scenarios: UsageScenario[] = SCENARIOS): void {
  console.log("Cost Comparison by Scenario");
  console.log("===========================");
  console.log("");
  console.log("Note: Costs are estimates based on public pricing as of Feb 2026.");
  console.log("Actual costs may vary based on usage patterns, region, and promotions.");
  console.log("");

  for (const scenario of scenarios) {
    console.log(`\n## ${scenario.name} Scenario`);
    console.log(`Vectors: ${scenario.vectors.toLocaleString()}`);
    console.log(`Dimensions: ${scenario.dimensions}`);
    console.log(`Queries/month: ${scenario.queries_per_month.toLocaleString()}`);
    console.log(`Writes/month: ${scenario.writes_per_month.toLocaleString()}`);
    console.log("");

    const estimates = estimateAllBackends(scenario);
    estimates.sort((a, b) => a.total_monthly_cost - b.total_monthly_cost);

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
  }
}

export function generateCostReport(): object {
  const report: {
    generated_at: string;
    pricing_version: string;
    scenarios: Array<{
      scenario: UsageScenario;
      estimates: CostEstimate[];
    }>;
  } = {
    generated_at: new Date().toISOString(),
    pricing_version: "2026-02",
    scenarios: [],
  };

  for (const scenario of SCENARIOS) {
    const estimates = estimateAllBackends(scenario);
    report.scenarios.push({
      scenario,
      estimates: estimates.sort((a, b) => a.total_monthly_cost - b.total_monthly_cost),
    });
  }

  return report;
}
