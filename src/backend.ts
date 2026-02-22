import type { Namespace } from "./download";
import type { WikiRecord } from "./parse";

export type BackendType = "tpuf" | "pinecone" | "supabase";

export interface VectorQueryResult {
  id: string;
  score: number; // cosine distance (0 = identical)
  title: string;
  text: string;
  vector?: number[];
}

export interface VectorNamespace {
  upsert(records: WikiRecord[], options: { isFirstBatch: boolean }): Promise<void>;
  query(params: {
    vector: number[];
    topK: number;
    includeVector?: boolean;
  }): Promise<VectorQueryResult[]>;
  fetchById(id: string): Promise<VectorQueryResult | null>;
  stats(): Promise<{ approxRowCount: number }>;
  deleteAll(): Promise<void>;
}

export interface VectorBackend {
  namespace(name: Namespace): VectorNamespace;
  ensureNamespace(name: Namespace): Promise<void>;
}

export async function createBackend(type: BackendType): Promise<VectorBackend> {
  switch (type) {
    case "tpuf": {
      const { createTpufBackend } = await import("./backend-tpuf");
      return createTpufBackend();
    }
    case "pinecone": {
      const { createPineconeBackend } = await import("./backend-pinecone");
      return createPineconeBackend();
    }
case "supabase": {
      const { createSupabaseBackend } = await import("./backend-supabase");
      return createSupabaseBackend();
    }
    default:
      throw new Error(`Unknown backend: ${type}`);
  }
}
