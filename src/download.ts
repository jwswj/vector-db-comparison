import { createWriteStream, existsSync, statSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";

const HF_BASE = "https://huggingface.co/datasets/jwswj/wikipedia-en-embeddings/resolve/main";

const DATASETS = [
  { name: "wiki_openai.ndjson.gz", url: `${HF_BASE}/wiki_openai.ndjson.gz` },
  { name: "wiki_minilm.ndjson.gz", url: `${HF_BASE}/wiki_minilm.ndjson.gz` },
  { name: "wiki_gte.ndjson.gz", url: `${HF_BASE}/wiki_gte.ndjson.gz` },
  { name: "wiki_3_small.ndjson.gz", url: `${HF_BASE}/wiki_3_small.ndjson.gz` },
  { name: "wiki_3_large.ndjson.gz", url: `${HF_BASE}/wiki_3_large.ndjson.gz` },
];

export const DATA_DIR = join(import.meta.dir, "..", "data");

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function downloadFile(url: string, dest: string, name: string): Promise<void> {
  console.log(`Downloading ${name}...`);

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download ${name}: ${response.status} ${response.statusText}`);
  }

  const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
  const writer = createWriteStream(dest);

  let downloaded = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const startTime = Date.now();
  let lastLogTime = startTime;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    writer.write(value);
    downloaded += value.length;

    const now = Date.now();
    if (now - lastLogTime > 1000) {
      const elapsed = (now - startTime) / 1000;
      const speed = downloaded / elapsed;
      const percent = contentLength ? ((downloaded / contentLength) * 100).toFixed(1) : "?";
      const eta = contentLength ? Math.round((contentLength - downloaded) / speed) : "?";
      process.stdout.write(
        `\r  ${formatBytes(downloaded)} / ${formatBytes(contentLength)} (${percent}%) - ${formatBytes(speed)}/s - ETA: ${eta}s   `
      );
      lastLogTime = now;
    }
  }

  writer.end();
  console.log(`\n  Completed: ${name}`);
}

export async function downloadDatasets(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  for (const dataset of DATASETS) {
    const dest = join(DATA_DIR, dataset.name);

    if (existsSync(dest)) {
      const stats = statSync(dest);
      console.log(`Skipping ${dataset.name} (already exists, ${formatBytes(stats.size)})`);
      continue;
    }

    await downloadFile(dataset.url, dest, dataset.name);
  }

  console.log("\nAll datasets downloaded.");
}

export function getDatasetPath(namespace: string): string {
  const mapping: Record<string, string> = {
    "wiki-openai": "wiki_openai.ndjson.gz",
    "wiki-minilm": "wiki_minilm.ndjson.gz",
    "wiki-gte": "wiki_gte.ndjson.gz",
    "wiki-3-small": "wiki_3_small.ndjson.gz",
    "wiki-3-large": "wiki_3_large.ndjson.gz",
  };
  const filename = mapping[namespace];
  if (!filename) throw new Error(`Unknown namespace: ${namespace}`);
  return join(DATA_DIR, filename);
}

export const NAMESPACES = [
  "wiki-openai", "wiki-minilm", "wiki-gte",
  "wiki-3-small", "wiki-3-large",
] as const;
export type Namespace = (typeof NAMESPACES)[number];
