import { createMissionControllerStore } from "../../src/index.ts";

const [missionsPath, action, ...values] = process.argv.slice(2);

if (missionsPath === undefined || action === undefined) {
  throw new Error("Expected missions path and action.");
}

const store = createMissionControllerStore({ missionsPath });

await run(action, values);

async function run(actionName: string, arguments_: readonly string[]): Promise<void> {
  if (actionName === "claim") {
    const [missionId, claimId, leaseMs, holdMs] = arguments_;
    if (missionId === undefined || claimId === undefined || leaseMs === undefined) {
      throw new Error("Expected mission ID, claim ID, and lease duration.");
    }
    const guard = await store.claim({ missionId, claimId, leaseMs: Number(leaseMs) });
    process.stdout.write(`${JSON.stringify({ guard })}\n`);
    if (holdMs !== undefined) await delay(Number(holdMs));
    return;
  }

  if (actionName === "sleep") {
    const [durationMs] = arguments_;
    if (durationMs === undefined) throw new Error("Expected sleep duration.");
    process.stdout.write("ready\n");
    await delay(Number(durationMs));
    return;
  }

  if (actionName === "fail") {
    const value = arguments_.join(" ");
    process.stdout.write(`fixture stdout ${value}\n`);
    process.stderr.write(`fixture stderr ${value}\n`);
    process.exitCode = 7;
    return;
  }

  throw new Error(`Unknown M10 process action: ${actionName}`);
}

function delay(durationMs: number): Promise<void> {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("Duration must be a non-negative number.");
  }
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
