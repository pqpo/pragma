import { type FileLockPhase, withFileLock } from "../../src/storage/file-lock.ts";

const lockDir = process.argv[2];
const staleMs = Number(process.argv[3]);
const crashPhaseArgument = process.argv[4];
const crashPhase =
  crashPhaseArgument === undefined || crashPhaseArgument === ""
    ? undefined
    : (crashPhaseArgument as FileLockPhase);
const mode = process.argv[5] as "hold" | "recover" | undefined;

if (lockDir === undefined || !Number.isFinite(staleMs)) {
  throw new Error("Expected lock directory and stale timeout arguments");
}

process.stdout.write("STARTING\n");
await withFileLock(
  lockDir,
  async () => {
    if (mode === "recover") {
      process.stdout.write("RECOVERED\n");
      return;
    }
    process.stdout.write("LOCKED\n");
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
    });
  },
  {
    staleMs,
    ...(crashPhase === undefined
      ? {}
      : {
          onPhase: (phase: FileLockPhase) => {
            if (phase === crashPhase) process.kill(process.pid, "SIGKILL");
          },
        }),
  },
);
