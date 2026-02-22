import { Pinecone } from "@pinecone-database/pinecone";
import type { Namespace } from "./download";
import type { WikiRecord } from "./parse";
import type { VectorBackend, VectorNamespace, VectorQueryResult } from "./backend";

const DIMENSION_MAP: Record<Namespace, number> = {
  "wiki-openai": 1536,
  "wiki-minilm": 384,
  "wiki-gte": 384,
  "wiki-3-small": 512,
  "wiki-3-large": 1024,
};

// Pinecone serverless upsert limit per call
const PINECONE_BATCH_SIZE = 100;

function indexName(namespace: Namespace): string {
  return namespace;
}

function createPineconeNamespace(
  pc: Pinecone,
  name: Namespace
): VectorNamespace {
  const idx = pc.index(indexName(name));

  return {
    async upsert(records: WikiRecord[], _options: { isFirstBatch: boolean }) {
      const vectors = records.map((r) => ({
        id: r.id,
        values: r.vector,
        metadata: {
          title: r.title,
          text: r.text,
        },
      }));

      // Chunk into batches of PINECONE_BATCH_SIZE
      for (let i = 0; i < vectors.length; i += PINECONE_BATCH_SIZE) {
        const chunk = vectors.slice(i, i + PINECONE_BATCH_SIZE);
        if (chunk.length > 0) {
          await idx.upsert({ records: chunk });
        }
      }
    },

    async query(params: {
      vector: number[];
      topK: number;
      includeVector?: boolean;
    }): Promise<VectorQueryResult[]> {
      const response = await idx.query({
        vector: params.vector,
        topK: params.topK,
        includeMetadata: true,
        includeValues: params.includeVector ?? false,
      });

      return (response.matches || []).map((m) => ({
        id: m.id,
        score: 1 - (m.score ?? 0), // Convert cosine similarity to distance
        title: (m.metadata?.title as string) || "Unknown",
        text: (m.metadata?.text as string) || "",
        ...(m.values ? { vector: m.values } : {}),
      }));
    },

    async fetchById(id: string): Promise<VectorQueryResult | null> {
      const response = await idx.fetch({ ids: [id] });
      const record = response.records?.[id];
      if (!record) return null;

      return {
        id: record.id,
        score: 0,
        title: (record.metadata?.title as string) || "Unknown",
        text: (record.metadata?.text as string) || "",
        ...(record.values ? { vector: record.values } : {}),
      };
    },

    async stats(): Promise<{ approxRowCount: number }> {
      const response = await idx.describeIndexStats();
      return { approxRowCount: response.totalRecordCount ?? 0 };
    },

    async deleteAll() {
      await idx.deleteAll();
    },
  };
}

export function createPineconeBackend(): VectorBackend {
  if (!process.env.PINECONE_API_KEY) {
    throw new Error("PINECONE_API_KEY environment variable is required");
  }

  const pc = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY!,
  });

  return {
    namespace(name: Namespace): VectorNamespace {
      return createPineconeNamespace(pc, name);
    },

    async ensureNamespace(name: Namespace): Promise<void> {
      const idxName = indexName(name);
      const dimension = DIMENSION_MAP[name];
      const region = process.env.PINECONE_REGION || "us-east-1";

      try {
        await pc.describeIndex(idxName);
        // Index already exists
      } catch {
        // Index doesn't exist — create it
        console.log(`Creating Pinecone index "${idxName}" (${dimension}d) in ${region}...`);
        await pc.createIndex({
          name: idxName,
          dimension,
          metric: "cosine",
          spec: {
            serverless: {
              cloud: "aws",
              region,
            },
          },
          waitUntilReady: true,
        });
        console.log(`Index "${idxName}" is ready.`);
      }
    },
  };
}
