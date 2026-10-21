import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pnpmInvocation } from "./pnpm-command.mjs";

const prepared = process.argv.includes("--prepared");
const lane = process.argv.find((argument) => argument.startsWith("--lane="))?.slice(7) ?? "all";
if (!["all", "host", "desktop"].includes(lane)) throw new Error("Unknown business test lane");
const resultsDirectory = resolve(".test-results");
await mkdir(resultsDirectory, { recursive: true });
const measurements = [];
async function run(args, name) {
  const start = performance.now();
  let status = "passed";
  try {
    await new Promise((accept, reject) => {
      const invocation = pnpmInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        stdio: "inherit",
        shell: false,
        env: { ...process.env, PRAGMA_LOG_LEVEL: "error" },
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? accept() : reject(new Error(`${name} exited ${code}`)),
      );
    });
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    measurements.push({
      name,
      status,
      seconds: Math.round((performance.now() - start) / 10) / 100,
    });
    await writeFile(
      resolve(resultsDirectory, "business-timing.json"),
      JSON.stringify(measurements, null, 2) + "\n",
    );
  }
}
async function vitest(pkg, files, extra = [], label = pkg) {
  await run(
    [
      "--filter",
      pkg,
      "exec",
      "vitest",
      "run",
      ...files,
      ...extra,
      `--maxWorkers=${pkg === "@pragma/local-host" ? 1 : 2}`,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${resolve(resultsDirectory, label.replaceAll("/", "-") + ".json")}`,
    ],
    label,
  );
}
if (!prepared) await run(["build"], "prepare");
if (lane !== "desktop") {
  await vitest("@pragma/core", [
    "test/file-lock.test.ts",
    "test/runtime-stream-controller.test.ts",
    "test/bundle-installation-state-migration.test.ts",
  ]);
  await vitest(
    "@pragma/local-host",
    [],
    ["--config=vitest.integration.config.ts", "--exclude=test/native-keychain-cross-host.test.ts"],
  );
  await vitest(
    "@pragma/local-host",
    ["test/host-storage-pool.test.ts"],
    ["-t", "loads the durable tracking cutoff"],
    "local-host-source-worker",
  );
  await vitest("@pqpo/pragma", []);
  await vitest("@pragma/memory", [
    "test/episodic-memory.test.ts",
    "test/semantic-memory.test.ts",
    "test/conversation-retry.test.ts",
    "test/conversation-extraction-coordinator.test.ts",
    "test/extraction-contract-v2.test.ts",
    "test/memory-plane.test.ts",
    "test/memory-activity.test.ts",
    "test/retrieval.test.ts",
    "test/memory-attention.test.ts",
    "test/jev-decision-provider.test.ts",
  ]);
  await vitest("@pragma/built-in-agents", ["test/pragma-management-tools.test.ts"]);

  for (const runtime of ["pi", "codex", "opencode", "claude-code", "qodercli", "antigravity"])
    await run(["--filter", `@pragma/runtime-${runtime}`, "test:core"], `runtime-${runtime}`);
  await vitest("@pragma/runtime-claude-code", [
    "test/availability.test.ts",
    "test/external-cli.test.ts",
    "test/executable.test.ts",
  ]);
}
if (lane !== "host") {
  await vitest("@pragma/desktop", [
    "src/test/mission-queued-chat-refresh.test.tsx",
    "src/renderer/src/pages/missions/mission-conversation-model.test.ts",
    "src/main/features/missions/desktop-mission-adapter.test.ts",
    "src/main/features/missions/desktop-mission-system-resources.test.ts",
    "src/main/features/missions/desktop-mission-cold-session.test.ts",
    "src/main/features/missions/mission-deletion.test.ts",
    "src/main/features/missions/mission-branch-context.test.ts",
    "src/main/features/missions/mission-adapter-host.test.ts",
    "src/main/features/runtimes/runtime-availability.test.ts",
    "src/main/features/runtimes/runtime-environment-service.test.ts",
    "src/main/features/runtimes/runtime-environment-store.test.ts",
    "src/main/features/model-providers/model-provider-ipc.test.ts",
    "src/main/features/model-providers/model-provider-store.test.ts",
    "src/main/features/model-providers/model-provider-boundary.test.ts",
    "src/main/features/model-providers/model-connectivity.test.ts",
    "src/main/features/model-providers/model-discovery.test.ts",
    "src/main/features/bundles/pragma-bundle-ipc.test.ts",
    "src/renderer/src/pages/studio/PragmaBundleDialog.test.tsx",
    "src/renderer/src/pages/settings/ModelProvidersFragment.test.tsx",
    "src/main/features/capabilities/capability-store.test.ts",
    "src/main/features/capabilities/capability-revision-coordinator.test.ts",
    "src/main/features/context-stores/context-store-store.test.ts",
    "src/main/features/projects/pragma-project-store.test.ts",
    "src/main/features/plugins/plugin-store.test.ts",
    "src/main/features/memory/desktop-memory-plane.test.ts",
    "src/main/features/memory/memory-curator.test.ts",
    "src/main/bootstrap/shutdown-sequence.test.ts",
    "src/main/features/context-stores/knowledge-revision-capability.test.ts",
    "src/main/features/context-stores/context-store-revision-service.test.ts",
  ]);
  await run(["--filter", "@pragma/desktop", "test:claude-worker"], "claude-worker");
}
