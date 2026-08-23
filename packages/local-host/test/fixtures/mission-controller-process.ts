import { access, appendFile, writeFile } from "node:fs/promises";

import { createMissionControllerStore } from "../../src/index.ts";

const [missionsPath, action, value] = process.argv.slice(2);

if (missionsPath === undefined || action === undefined) {
  throw new Error("Expected missions path and action.");
}

const store = createMissionControllerStore({ missionsPath });

if (action === "race") {
  const [owner, startPath, outputPath] = value?.split("|") ?? [];
  if (owner === undefined || startPath === undefined || outputPath === undefined) {
    throw new Error("Expected race owner, start path, and output path.");
  }
  process.stdout.write("ready\n");
  while (!(await exists(startPath))) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const results: Array<{
    readonly missionId: string;
    readonly owner: string;
    readonly code?: string;
  }> = [];
  for (let index = 0; index < 100; index += 1) {
    const missionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    try {
      await store.claim({ missionId, claimId: owner, leaseMs: 10_000 });
      results.push({ missionId, owner });
    } catch (error) {
      results.push({
        missionId,
        owner,
        code:
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "UNKNOWN",
      });
    }
  }
  await writeFile(outputPath, JSON.stringify(results));
  process.exit(0);
}

if (action === "claim") {
  const [missionId, claimId, leaseMs, holdMs] = value?.split("|") ?? [];
  if (missionId === undefined || claimId === undefined || leaseMs === undefined) {
    throw new Error("Expected claim input.");
  }
  try {
    const guard = await store.claim({ missionId, claimId, leaseMs: Number(leaseMs) });
    process.stdout.write(`${JSON.stringify({ guard })}\n`);
    if (holdMs !== undefined) await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ code: (error as { readonly code?: string }).code })}\n`,
    );
    process.exitCode = 1;
  }
  process.exit();
}

if (action === "claim-then-assert") {
  const [missionId, claimId, leaseMs, delayMs] = value?.split("|") ?? [];
  if (
    missionId === undefined ||
    claimId === undefined ||
    leaseMs === undefined ||
    delayMs === undefined
  ) {
    throw new Error("Expected claim and assertion input.");
  }
  const guard = await store.claim({ missionId, claimId, leaseMs: Number(leaseMs) });
  process.stdout.write(`${JSON.stringify({ guard })}\n`);
  await new Promise((resolve) => setTimeout(resolve, Number(delayMs)));
  try {
    await store.assertWriteGuard({ missionId, guard });
    process.stdout.write(`${JSON.stringify({ code: "UNEXPECTED_WRITE_ALLOWED" })}\n`);
    process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ code: (error as { readonly code?: string }).code })}\n`,
    );
  }
  process.exit();
}

if (action === "append-inbox") {
  const [missionId, requestId, mode] = value?.split("|") ?? [];
  if (missionId === undefined || requestId === undefined || mode === undefined) {
    throw new Error("Expected Inbox command input.");
  }
  await store.appendCommand({
    missionId,
    kind: "send",
    request: {
      schemaVersion: "pragma.integration-request/v1",
      requestId,
      payloadHash: `sha256:${"a".repeat(64)}`,
      requestedAt: "2026-08-24T00:00:00.000Z",
      client: {
        surface: "cli",
        version: "process-test",
        instanceId: "00000000-0000-4000-8000-000000000099",
      },
    },
    ...(mode === "expire" ? { expiresAt: "2020-01-01T00:00:00.000Z" } : {}),
    payload: { kind: "send", input: { prompt: `process-${mode}` } },
  });
  process.stdout.write("appended\n");
  process.exit();
}

if (action === "apply-then-hang" || action === "apply-once") {
  const [missionId, claimId, leaseMs, deliveriesPath, sideEffectPath] = value?.split("|") ?? [];
  if (
    missionId === undefined ||
    claimId === undefined ||
    leaseMs === undefined ||
    deliveriesPath === undefined ||
    sideEffectPath === undefined
  ) {
    throw new Error("Expected owner apply input.");
  }
  const guard = await store.claim({ missionId, claimId, leaseMs: Number(leaseMs) });
  const keepAlive = action === "apply-then-hang" ? setInterval(() => undefined, 1_000) : undefined;
  await store.processNext({
    missionId,
    guard,
    consumer: {
      apply: async ({ command }) => {
        await appendFile(deliveriesPath, `${command.commandId}\n`);
        await writeFile(sideEffectPath, command.commandId, { flag: "wx" }).catch((error: unknown) => {
          if ((error as { readonly code?: string }).code !== "EEXIST") throw error;
        });
        process.stdout.write("side-effect\n");
        if (action === "apply-then-hang") await new Promise<void>(() => undefined);
        return { result: { commandId: command.commandId } };
      },
    },
  });
  if (keepAlive !== undefined) clearInterval(keepAlive);
  process.stdout.write("applied\n");
  process.exit();
}

throw new Error(`Unknown process action: ${action}`);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
