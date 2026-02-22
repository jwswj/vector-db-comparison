import { NAMESPACES, type Namespace } from "./download";
import type { VectorBackend } from "./backend";

interface QueryResult {
  namespace: string;
  results: Array<{
    id: string;
    dist: number;
    title: string;
    text: string;
  }>;
}

export async function getStats(backend: VectorBackend): Promise<void> {
  console.log("\nNamespace Statistics:");
  console.log("─".repeat(60));

  for (const namespace of NAMESPACES) {
    try {
      const ns = backend.namespace(namespace);
      const { approxRowCount } = await ns.stats();
      console.log(`${namespace}: ${approxRowCount.toLocaleString()} rows`);
    } catch (e) {
      const err = e as Error;
      if (err.message?.includes("not found") || err.message?.includes("404")) {
        console.log(`${namespace}: (not found)`);
      } else {
        console.log(`${namespace}: Error - ${err.message}`);
      }
    }
  }
}

export async function queryByDocId(
  backend: VectorBackend,
  docId: string,
  topK: number = 10
): Promise<void> {
  console.log(`\nQuerying with document ID: ${docId}`);
  console.log("─".repeat(60));

  // First, find the document and its vector from any namespace
  let sourceVector: number[] | null = null;
  let sourceTitle: string = "";
  let sourceNamespace: string = "";

  for (const namespace of NAMESPACES) {
    try {
      const ns = backend.namespace(namespace);
      const result = await ns.fetchById(docId);

      if (result && result.vector) {
        sourceVector = result.vector;
        sourceTitle = result.title;
        sourceNamespace = namespace;
        break;
      }
    } catch {
      // Namespace might not exist
    }
  }

  if (!sourceVector) {
    console.log(`Document ${docId} not found in any namespace.`);
    return;
  }

  console.log(`Source document: "${sourceTitle}" (from ${sourceNamespace})`);
  console.log(`Vector dimensions: ${sourceVector.length}\n`);

  // Query all namespaces with matching dimensions using ANN
  const results: QueryResult[] = [];

  for (const namespace of NAMESPACES) {
    try {
      const ns = backend.namespace(namespace);
      const queryResults = await ns.query({
        vector: sourceVector,
        topK,
      });

      if (queryResults.length > 0) {
        results.push({
          namespace,
          results: queryResults.map((r) => ({
            id: r.id,
            dist: r.score,
            title: r.title,
            text: r.text.slice(0, 100) + "...",
          })),
        });
      }
    } catch (e) {
      const err = e as Error;
      if (err.message?.includes("dimensions") || err.message?.includes("dimension")) {
        console.log(`${namespace}: Skipped (dimension mismatch)`);
      } else if (!err.message?.includes("not found")) {
        console.log(`${namespace}: Error - ${err.message}`);
      }
    }
  }

  // Print comparison table
  for (const result of results) {
    console.log(`\n${result.namespace}:`);
    console.log("─".repeat(60));
    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      console.log(`  ${i + 1}. [${r.dist.toFixed(4)}] ${r.title}`);
    }
  }
}

export async function deleteNamespaces(
  backend: VectorBackend,
  confirm: boolean,
  namespace?: Namespace
): Promise<void> {
  const toDelete = namespace ? [namespace] : [...NAMESPACES];

  if (!confirm) {
    console.log("\nThe following namespaces would be deleted:");
    for (const ns of toDelete) {
      console.log(`  - ${ns}`);
    }
    console.log("\nRun with --confirm to actually delete.");
    return;
  }

  console.log("\nDeleting namespaces...");
  for (const nsName of toDelete) {
    try {
      const ns = backend.namespace(nsName);
      await ns.deleteAll();
      console.log(`  Deleted: ${nsName}`);
    } catch (e) {
      const err = e as Error;
      if (err.message?.includes("not found")) {
        console.log(`  Skipped: ${nsName} (not found)`);
      } else {
        console.log(`  Error deleting ${nsName}: ${err.message}`);
      }
    }
  }
}
