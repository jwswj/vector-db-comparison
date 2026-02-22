# vector-db-comparison

Seed, query, and benchmark vector databases using Wikipedia embeddings. Supports [turbopuffer](https://turbopuffer.com), [Pinecone](https://www.pinecone.io), and [Supabase](https://supabase.com) (pgvector), with cost estimation across all three plus Elasticsearch and OpenSearch.

## Datasets

~224K Wikipedia articles with pre-computed embeddings, initially from [Supabase/wikipedia-en-embeddings](https://huggingface.co/datasets/Supabase/wikipedia-en-embeddings) but also includes OpenAIs small and large.

| Namespace | Model | Dimensions |
|-----------|-------|------------|
| wiki-openai | ada-002 | 1536 |
| wiki-minilm | all-MiniLM-L6-v2 | 384 |
| wiki-gte | gte-small | 384 |
| wiki-3-small | text-embedding-3-small | 512 |
| wiki-3-large | text-embedding-3-large | 1024 |

All five are hosted on [Hugging Face](https://huggingface.co/datasets/jwswj/wikipedia-en-embeddings) and downloaded with the `download` command.

## Setup

Requires [Bun](https://bun.sh).

```sh
bun install
cp .env.example .env
# Fill in your API keys in .env
```

## Usage

All commands are run via `bun src/index.ts`. Use `--backend` to select a backend (default: `tpuf`).

### Download datasets

```sh
bun src/index.ts download
```

Downloads all five datasets (~6.4GB total) from Hugging Face to `data/`.

### Seed a backend

```sh
bun src/index.ts seed
bun src/index.ts seed --namespace wiki-gte --limit 1000
bun src/index.ts seed --backend pinecone --batch-size 100
```

### Generate embeddings

Re-embed text using OpenAI's newer models:

```sh
bun src/index.ts embed --model text-embedding-3-small
bun src/index.ts embed --model text-embedding-3-large --concurrency 3
```

### Query

```sh
bun src/index.ts query --doc-id "some-document-id"
```

### Benchmarks

```sh
# Recall (turbopuffer only — uses the recall API)
bun src/index.ts recall-benchmark

# Single-query latency
bun src/index.ts latency-benchmark --queries 50

# Throughput (QPS under load)
bun src/index.ts throughput-benchmark --concurrency 10

# Upsert throughput
bun src/index.ts upsert-benchmark --namespace wiki-gte --records 10000
```

All benchmarks accept `--output <path>` to save JSON results.

### Cost estimation

Compare estimated monthly costs across backends:

```sh
bun src/index.ts cost-estimate
bun src/index.ts cost-estimate --vectors 1000000 --dimensions 384 --queries 500000
```

### Other commands

```sh
bun src/index.ts stats                    # Namespace row counts
bun src/index.ts delete --confirm         # Delete all wiki-* namespaces
bun src/index.ts supabase-sql             # Generate pgvector setup SQL
```

## Environment variables

| Variable | Required for |
|----------|-------------|
| `TURBOPUFFER_API_KEY` | turbopuffer backend |
| `TURBOPUFFER_REGION` | turbopuffer (optional) |
| `PINECONE_API_KEY` | pinecone backend |
| `SUPABASE_URL` | supabase backend |
| `SUPABASE_ANON_KEY` | supabase backend |
| `OPENAI_API_KEY` | `embed` command |

## License

MIT
