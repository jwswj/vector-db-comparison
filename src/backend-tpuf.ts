import Turbopuffer from "@turbopuffer/turbopuffer";
import type { Namespace } from "./download";
import type { WikiRecord } from "./parse";
import type { VectorBackend, VectorNamespace, VectorQueryResult } from "./backend";

interface TpufQueryResponse {
  rows: Array<{
    id: string | number;
    $dist?: number;
    vector?: number[];
    title?: string;
    text?: string;
    [key: string]: unknown;
  }>;
}

function createTpufNamespace(
  tpuf: Turbopuffer,
  name: Namespace
): VectorNamespace {
  const ns = tpuf.namespace(name);

  return {
    async upsert(records: WikiRecord[], options: { isFirstBatch: boolean }) {
      // Turbopuffer has a 4096 byte limit on attribute values for filtering
      // Use 3500 chars to safely account for multi-byte UTF-8 characters
      const TEXT_LIMIT = 3500;
      const rows = records.map((r) => ({
        id: r.id,
        vector: r.vector,
        title: r.title,
        text: r.text.length > TEXT_LIMIT ? r.text.slice(0, TEXT_LIMIT) : r.text,
      }));

      const writeOptions: Parameters<typeof ns.write>[0] = {
        upsert_rows: rows,
        distance_metric: "cosine_distance",
      };

      if (options.isFirstBatch) {
        writeOptions.schema = {
          text: {
            type: "string",
            full_text_search: {
              stemming: true,
              remove_stopwords: true,
              case_sensitive: false,
            },
          },
          title: {
            type: "string",
            full_text_search: {
              stemming: true,
              remove_stopwords: true,
              case_sensitive: false,
            },
          },
        };
      }

      await ns.write(writeOptions);
    },

    async query(params: {
      vector: number[];
      topK: number;
      includeVector?: boolean;
    }): Promise<VectorQueryResult[]> {
      const includeAttributes: string[] = ["title", "text"];
      if (params.includeVector) includeAttributes.push("vector");

      const response = (await ns.query({
        rank_by: ["vector", "ANN", params.vector],
        top_k: params.topK,
        include_attributes: includeAttributes,
      })) as TpufQueryResponse;

      return (response.rows || []).map((r) => ({
        id: String(r.id),
        score: r.$dist ?? 0,
        title: (r.title as string) || "Unknown",
        text: (r.text as string) || "",
        ...(r.vector ? { vector: r.vector } : {}),
      }));
    },

    async fetchById(id: string): Promise<VectorQueryResult | null> {
      const response = (await ns.query({
        filters: ["id", "Eq", id],
        top_k: 1,
        include_attributes: ["title", "text", "vector"],
      })) as TpufQueryResponse;

      if (!response.rows || response.rows.length === 0) return null;

      const r = response.rows[0];
      return {
        id: String(r.id),
        score: r.$dist ?? 0,
        title: (r.title as string) || "Unknown",
        text: (r.text as string) || "",
        ...(r.vector ? { vector: r.vector } : {}),
      };
    },

    async stats(): Promise<{ approxRowCount: number }> {
      const meta = await ns.metadata();
      return { approxRowCount: meta.approx_row_count };
    },

    async deleteAll() {
      await ns.deleteAll();
    },
  };
}

export function createTpufBackend(): VectorBackend {
  if (!process.env.TURBOPUFFER_API_KEY) {
    throw new Error("TURBOPUFFER_API_KEY environment variable is required");
  }

  const region = process.env.TURBOPUFFER_REGION || undefined;
  if (region) {
    console.log(`Using Turbopuffer region: ${region}`);
  }

  const tpuf = new Turbopuffer({
    apiKey: process.env.TURBOPUFFER_API_KEY!,
    region,
  });

  return {
    namespace(name: Namespace): VectorNamespace {
      return createTpufNamespace(tpuf, name);
    },

    async ensureNamespace(_name: Namespace): Promise<void> {
      // No-op for Turbopuffer — namespaces are created on first write
    },
  };
}
