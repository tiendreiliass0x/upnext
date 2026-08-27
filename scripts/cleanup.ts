import { runCleanup } from "@/lib/cleanup";
import { closeDatabase } from "@/lib/db";

async function main() {
  const startedAt = Date.now();
  const summary = await runCleanup();
  const durationMs = Date.now() - startedAt;

  console.log(JSON.stringify({ ...summary, durationMs }));

  if (summary.storageSkipped) {
    console.error(
      "R2 credentials are incomplete, so previews were left in place.",
    );
    return 1;
  }
  if (summary.retriedObjects > 0) {
    console.error(
      `${summary.retriedObjects} preview(s) could not be deleted and will be retried.`,
    );
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
