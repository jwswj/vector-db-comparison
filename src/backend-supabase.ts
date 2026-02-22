import { createClient, SupabaseClient } from "@supabase/supabase-js";
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

// Supabase/Postgres handles batches well
const SUPABASE_BATCH_SIZE = 500;

// 4KB limit on text fields (matching Turbopuffer's limit)
const TEXT_LIMIT = 4000;

function tableName(namespace: Namespace): string {
  // Replace hyphens with underscores for valid SQL table names
  return namespace.replace(/-/g, "_");
}

function createSupabaseNamespace(
  client: SupabaseClient,
  name: Namespace
): VectorNamespace {
  const table = tableName(name);
  const dimensions = DIMENSION_MAP[name];

  return {
    async upsert(records: WikiRecord[], options: { isFirstBatch: boolean }) {
      if (options.isFirstBatch) {
        // Create table if it doesn't exist using raw SQL via RPC
        // Note: This requires a Supabase function or you can use the SQL editor
        // For now, we'll assume tables are pre-created
        console.log(`Upserting to table "${table}" (${dimensions}d)`);
      }

      // Chunk into batches
      for (let i = 0; i < records.length; i += SUPABASE_BATCH_SIZE) {
        const chunk = records.slice(i, i + SUPABASE_BATCH_SIZE);
        const rows = chunk.map((r) => ({
          id: r.id,
          title: r.title,
          text: r.text.length > TEXT_LIMIT ? r.text.slice(0, TEXT_LIMIT) : r.text,
          embedding: r.vector,
        }));

        const { error } = await client
          .from(table)
          .upsert(rows, { onConflict: "id" });

        if (error) {
          throw new Error(`Supabase upsert error: ${error.message}`);
        }
      }
    },

    async query(params: {
      vector: number[];
      topK: number;
      includeVector?: boolean;
    }): Promise<VectorQueryResult[]> {
      // Use Supabase's vector similarity search function
      // This requires a stored function in Supabase:
      // CREATE FUNCTION match_documents(query_embedding vector(N), match_count int)
      // RETURNS TABLE (id text, title text, text text, similarity float)
      // LANGUAGE plpgsql AS $$
      // BEGIN
      //   RETURN QUERY
      //   SELECT id, title, text, 1 - (embedding <=> query_embedding) as similarity
      //   FROM table_name
      //   ORDER BY embedding <=> query_embedding
      //   LIMIT match_count;
      // END;
      // $$;

      // For a generic approach, we use the RPC function pattern
      const functionName = `match_${table}`;

      const { data, error } = await client.rpc(functionName, {
        query_embedding: params.vector,
        match_count: params.topK,
      });

      if (error) {
        throw new Error(`Supabase query error: ${error.message}`);
      }

      return (data || []).map((row: {
        id: string;
        title: string;
        text: string;
        similarity: number;
        embedding?: number[];
      }) => ({
        id: row.id,
        score: 1 - row.similarity, // Convert similarity to distance
        title: row.title || "Unknown",
        text: row.text || "",
        ...(row.embedding ? { vector: row.embedding } : {}),
      }));
    },

    async fetchById(id: string): Promise<VectorQueryResult | null> {
      const { data, error } = await client
        .from(table)
        .select("id, title, text, embedding")
        .eq("id", id)
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          // No rows returned
          return null;
        }
        throw new Error(`Supabase fetch error: ${error.message}`);
      }

      if (!data) return null;

      return {
        id: data.id,
        score: 0,
        title: data.title || "Unknown",
        text: data.text || "",
        ...(data.embedding ? { vector: data.embedding } : {}),
      };
    },

    async stats(): Promise<{ approxRowCount: number }> {
      const { count, error } = await client
        .from(table)
        .select("*", { count: "exact", head: true });

      if (error) {
        if (error.code === "42P01") {
          // Table doesn't exist
          return { approxRowCount: 0 };
        }
        throw new Error(`Supabase stats error: ${error.message}`);
      }

      return { approxRowCount: count ?? 0 };
    },

    async deleteAll() {
      // Delete all rows from the table
      const { error } = await client
        .from(table)
        .delete()
        .neq("id", ""); // Delete all rows with non-empty id

      if (error && error.code !== "42P01") {
        throw new Error(`Supabase delete error: ${error.message}`);
      }
    },
  };
}

export function createSupabaseBackend(): VectorBackend {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error("SUPABASE_URL environment variable is required");
  }
  if (!key) {
    throw new Error("SUPABASE_ANON_KEY environment variable is required");
  }

  const client = createClient(url, key);

  return {
    namespace(name: Namespace): VectorNamespace {
      return createSupabaseNamespace(client, name);
    },

    async ensureNamespace(name: Namespace): Promise<void> {
      const table = tableName(name);
      const dimensions = DIMENSION_MAP[name];

      // Note: Table and function creation requires elevated privileges
      // This should typically be done via Supabase dashboard or migrations
      // Here we just log what needs to be created
      console.log(`
Ensure the following SQL has been run in your Supabase project:

-- Enable pgvector extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS vector;

-- Create table for ${name}
CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  title TEXT,
  text TEXT,
  embedding vector(${dimensions})
);

-- Create HNSW index for fast similarity search
CREATE INDEX IF NOT EXISTS ${table}_embedding_idx
ON ${table} USING hnsw (embedding vector_cosine_ops);

-- Create similarity search function
CREATE OR REPLACE FUNCTION match_${table}(
  query_embedding vector(${dimensions}),
  match_count int
)
RETURNS TABLE (
  id text,
  title text,
  text text,
  similarity float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    ${table}.id,
    ${table}.title,
    ${table}.text,
    1 - (${table}.embedding <=> query_embedding) as similarity
  FROM ${table}
  ORDER BY ${table}.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
`);
    },
  };
}

// Helper function to generate SQL for all namespaces
export function generateSupabaseSQL(): string {
  const sql: string[] = [
    "-- Enable pgvector extension",
    "CREATE EXTENSION IF NOT EXISTS vector;",
    "",
  ];

  for (const ns of Object.keys(DIMENSION_MAP) as Namespace[]) {
    const table = tableName(ns);
    const dims = DIMENSION_MAP[ns];

    sql.push(`-- Table and function for ${ns}`);
    sql.push(`CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  title TEXT,
  text TEXT,
  embedding vector(${dims})
);`);
    sql.push("");
    sql.push(`CREATE INDEX IF NOT EXISTS ${table}_embedding_idx
ON ${table} USING hnsw (embedding vector_cosine_ops);`);
    sql.push("");
    sql.push(`CREATE OR REPLACE FUNCTION match_${table}(
  query_embedding vector(${dims}),
  match_count int
)
RETURNS TABLE (
  id text,
  title text,
  text text,
  similarity float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    ${table}.id,
    ${table}.title,
    ${table}.text,
    1 - (${table}.embedding <=> query_embedding) as similarity
  FROM ${table}
  ORDER BY ${table}.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;`);
    sql.push("");
  }

  return sql.join("\n");
}
