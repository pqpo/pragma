import { recordArtifact } from "./build-artifact.mjs";
import { execFileSync, spawn } from "node:child_process";
import { pnpmInvocation } from "./pnpm-command.mjs";
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const invocation = pnpmInvocation([
  "exec",
  "turbo",
  "run",
  "build",
  "--concurrency=2",
  ...process.argv.slice(2),
]);
const child = spawn(invocation.command, invocation.args, {
  stdio: "inherit",
  shell: false,
  env: { ...process.env, PRAGMA_SOURCE_COMMIT: sourceCommit, GOMAXPROCS: "2" },
});
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("close", async (code) => {
  process.exitCode = code ?? 1;
  if (code === 0 && process.argv.length === 2) {
    try {
      await recordArtifact("cli");
      await recordArtifact("desktop");
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
});
