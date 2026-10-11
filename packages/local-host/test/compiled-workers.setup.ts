import type { WorkerOptions } from "node:worker_threads";
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { vi } from "vitest";

// Real Node Workers and real databases, using the same bundles shipped in the CLI.
// Loading a fresh workspace module graph for each fixture is substantially slower.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const name = basename(filename instanceof URL ? filename.pathname : filename);
        const bundled = ["sqlite-execution-worker.js", "canonical-event-feed-worker.js"].includes(
          name,
        )
          ? new URL(`../../../apps/cli/dist/${name}`, import.meta.url)
          : undefined;
        if (bundled !== undefined && !existsSync(bundled))
          throw new Error(
            `Missing production Worker bundle: ${bundled}. Prepare the CLI build first.`,
          );
        super(bundled ?? filename, options);
      }
    },
  };
});
