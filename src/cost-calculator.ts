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

// Pinecone pricing (Serverless, as of 2024)
// - Free tier: 2GB storage, 1M reads/month, 2M writes/month
// - Standard: $50/month minimum
// - Storage: $0.33/GB/month
// - Read units: $16 per 1M RU
// - Write units: $4 per 1M WU
function estimatePinecone(scenario: UsageScenario): CostEstimate {
  const storage_gb = calculateStorageGB(scenario.vectors, scenario.dimensions);

  // Free tier limits
  const free_storage_gb = 2;
  const free_reads = 1_000_000;
  const free_writes = 2_000_000;

  const billable_storage = Math.max(0, storage_gb - free_storage_gb);
  const billable_queries = Math.max(0, scenario.queries_per_month - free_reads);
  const billable_writes = Math.max(0, scenario.writes_per_month - free_writes);

  const storage_cost = billable_storage * 0.33;
  const query_cost = (billable_queries / 1_000_000) * 16; // $16/M reads
  const write_cost = (billable_writes / 1_000_000) * 4;   // $4/M writes

  const usage_total = storage_cost + query_cost + write_cost;

  // $50/month minimum for Standard plan (if exceeding free tier)
  const exceeds_free_tier = billable_storage > 0 || billable_queries > 0 || billable_writes > 0;
  const minimum_cost = exceeds_free_tier ? 50 : 0;
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
      exceeds_free_tier ? "Standard plan ($50 min)" : "Free tier",
      "Storage: $0.33/GB, Reads: $16/M, Writes: $4/M",
      "Scales automatically",
    ],
  };
}

// Elasticsearch (Elastic Cloud Serverless, as of 2024)
// - Pay-per-use with VCU (Virtual Compute Units)
// - Search: $0.095/VCU-hour
// - Ingest: $0.095/VCU-hour (shared with search)
// - Storage: $0.047/GB/month (after 50GB free)
// - Minimum ~2 VCU active = ~$140/month baseline
// - IMPORTANT: Vector search uses "Vector Optimized" profile
//   which consumes ~4x more VCUs than standard text search
function estimateElasticsearch(scenario: UsageScenario): CostEstimate {
  const storage_gb = calculateStorageGB(scenario.vectors, scenario.dimensions);

  // 50GB free storage
  const free_storage_gb = 50;
  const billable_storage = Math.max(0, storage_gb - free_storage_gb);
  const storage_cost = billable_storage * 0.047;

  const hours_per_month = 24 * 30;

  // Estimate VCU usage based on query volume
  // Vector search is much more compute-intensive than text search
  // Assuming ~2,500 vector queries/VCU-hour (4x less than text search)
  // This is based on Elastic's "Vector Optimized" profile documentation
  const queries_per_hour = scenario.queries_per_month / hours_per_month;
  const query_vcus_needed = queries_per_hour / 2_500;

  // Vector indexing is also more expensive (~10K writes/VCU-hour)
  const writes_per_hour = scenario.writes_per_month / hours_per_month;
  const write_vcus_needed = writes_per_hour / 10_000;

  // Minimum 2 VCU baseline for serverless (always-on)
  const min_vcus = 2;
  const total_vcus = Math.max(query_vcus_needed + write_vcus_needed, min_vcus);
  const total_vcu_hours = total_vcus * hours_per_month;
  const min_vcu_hours = min_vcus * hours_per_month;

  const compute_cost = total_vcu_hours * 0.095;

  return {
    backend: "elastic",
    scenario: scenario.name,
    storage_gb,
    storage_cost,
    query_cost: 0,
    write_cost: 0,
    compute_cost,
    minimum_cost: min_vcu_hours * 0.095, // ~$137
    total_monthly_cost: storage_cost + compute_cost,
    notes: [
      "VCU-based serverless pricing",
      "Vector search uses ~4x more VCUs than text",
      "~$140/month minimum (2 VCU baseline)",
    ],
  };
}

// AWS OpenSearch Serverless (AOSS, as of 2024)
// - Minimum 2 OCUs (OpenSearch Compute Units) = ~$175/month
// - $0.24/OCU-hour
// - Storage: $0.024/GB/month
// - Search OCU: handles queries
// - Indexing OCU: handles writes
function estimateOpenSearch(scenario: UsageScenario): CostEstimate {
  const storage_gb = calculateStorageGB(scenario.vectors, scenario.dimensions);
  const storage_cost = storage_gb * 0.024;

  // Minimum 2 OCUs (1 search + 1 indexing) always running
  const min_ocu = 2;
  const hours_per_month = 24 * 30;

  // Scale OCUs based on load (rough estimate)
  // 1 search OCU can handle ~10K queries/hour
  const search_ocu = Math.max(1, scenario.queries_per_month / (10_000 * hours_per_month));
  // 1 indexing OCU can handle ~50K writes/hour
  const indexing_ocu = Math.max(1, scenario.writes_per_month / (50_000 * hours_per_month));

  const total_ocu = Math.max(search_ocu + indexing_ocu, min_ocu);
  const compute_cost = total_ocu * hours_per_month * 0.24;

  return {
    backend: "opensearch",
    scenario: scenario.name,
    storage_gb,
    storage_cost,
    query_cost: 0,
    write_cost: 0,
    compute_cost,
    minimum_cost: min_ocu * hours_per_month * 0.24, // ~$346
    total_monthly_cost: storage_cost + compute_cost,
    notes: [
      "OCU-based serverless pricing",
      "Minimum 2 OCUs required (~$346/month)",
      "High minimum for low-usage workloads",
    ],
  };
}

// Supabase/pgvector pricing (as of 2024)
// - Free tier: 500MB storage, 2GB bandwidth
// - Pro: $25/month, 8GB storage, 250GB bandwidth
// - Team: $599/month, 100GB storage
// - Pay-as-you-go storage: $0.125/GB/month (above included)
function estimateSupabase(scenario: UsageScenario): CostEstimate {
  const storage_gb = calculateStorageGB(scenario.vectors, scenario.dimensions);

  // Determine tier based on storage needs
  let tier: "free" | "pro" | "team" = "free";
  let base_cost = 0;
  let included_storage = 0.5;

  if (storage_gb > 0.5) {
    tier = "pro";
    base_cost = 25;
    included_storage = 8;
  }
  if (storage_gb > 8) {
    tier = "team";
    base_cost = 599;
    included_storage = 100;
  }

  const extra_storage = Math.max(0, storage_gb - included_storage);
  const storage_cost = extra_storage * 0.125;

  // Supabase doesn't charge per query (within compute limits)
  // Large query volumes may need compute upgrades
  const query_cost = 0;
  const write_cost = 0;

  return {
    backend: "supabase",
    scenario: scenario.name,
    storage_gb,
    storage_cost,
    query_cost,
    write_cost,
    compute_cost: 0,
    minimum_cost: base_cost,
    total_monthly_cost: base_cost + storage_cost,
    notes: [
      `${tier.charAt(0).toUpperCase() + tier.slice(1)} tier`,
      tier === "free" ? "500MB storage included" : tier === "pro" ? "8GB storage included" : "100GB storage included",
      "No per-query charges",
      "Limited by compute (may need upgrades for high QPS)",
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
  console.log("Note: Costs are estimates based on public pricing as of 2024.");
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
    pricing_version: "2024-01",
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
