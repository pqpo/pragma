import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { SIGKILL_REPLAY_TEST_NAME } from "./mission-controller-process.test-names.ts";

const children = new Set<ChildProcess>();
const collectionTimeoutMs = 25_000;

afterEach(async () => {
  const active = [...children].filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  active.forEach((child) => killProcessTree(child));
  await Promise.all(active.map(async (child) => await waitForClose(child)));
});

it.each(Array.from({ length: 10 }, (_, index) => index + 1))(
  "registers the SIGKILL replay test with Vitest (serial round %i)",
  async () => {
    await assertCollection();
  },
  30_000,
);

it("registers the SIGKILL replay test under controlled concurrent collection", async () => {
  await Promise.all([assertCollection(), assertCollection(), assertCollection()]);
}, 30_000);

async function assertCollection(): Promise<void> {
  const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
  const packageRoot = join(repositoryRoot, "packages", "local-host");
  const vitest = join(
    repositoryRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest",
  );
  const result = await invoke(
    vitest,
    ["list", "test/mission-controller-process.integration.test.ts"],
    { cwd: packageRoot },
    collectionTimeoutMs,
  );

  expect(result.exitCode).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.timedOut).toBe(false);
  const collected = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.includes(SIGKILL_REPLAY_TEST_NAME));
  expect(collected).toHaveLength(1);
}

function invoke(
  executable: string,
  arguments_: readonly string[],
  options: { readonly cwd: string },
  timeoutMs: number,
): Promise<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && executable.endsWith(".cmd"),
      detached: process.platform !== "win32",
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: {
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly timedOut: boolean;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.once("error", (error) => {
      children.delete(child);
      finish({
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}${error instanceof Error ? error.message : String(error)}`,
        timedOut,
      });
    });
    child.once("close", (exitCode, signal) => {
      children.delete(child);
      finish({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // The child may have exited between the timeout and the tree kill.
  }
}
