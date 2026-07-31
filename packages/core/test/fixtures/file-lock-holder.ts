import { withFileLock } from "../../src/storage/file-lock.ts";

const lockDir = process.argv[2];
const staleMs = Number(process.argv[3]);

if (lockDir === undefined || !Number.isFinite(staleMs)) {
  throw new Error("Expected lock directory and stale timeout arguments");
}

await withFileLock(
  lockDir,
  async () => {
    process.stdout.write("LOCKED\n");
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
    });
  },
  { staleMs },
);
