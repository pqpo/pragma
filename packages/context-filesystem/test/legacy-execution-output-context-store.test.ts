import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PragmaPaths, withExecutionRunScope } from "@pragma/core";
import { describe, expect, it } from "vitest";

import {
  LEGACY_EXECUTION_OUTPUT_NAMESPACE,
  LegacyExecutionOutputContextStore,
} from "../src/index.ts";

describe("LegacyExecutionOutputContextStore", () => {
  it("keeps migrated v8 Context references readable without restoring legacy writes", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-legacy-output-"));
    const paths = new PragmaPaths({ pragmaHome: home });
    const executionId = "legacy-execution";
    const id = "invocations/root/output.txt";
    const content = "legacy output\nsecond line\n";
    const relativePath = `generated/${id}`;
    const outputPath = join(paths.executionHandoffsRoot(executionId), relativePath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, "utf8");
    await writeFile(
      paths.executionHandoffsManifest(executionId),
      JSON.stringify({
        schemaVersion: "pragma.execution-handoffs/v2",
        entries: [
          {
            id,
            invocationId: "root",
            attemptId: "attempt-1",
            source: {
              type: "managed",
              relativePath,
              sha256: createHash("sha256").update(content).digest("hex"),
            },
            mediaType: "text/plain",
            description: "Historical large output",
            idempotencyKey: "automatic-output:root:attempt-1",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8",
    );
    const store = new LegacyExecutionOutputContextStore({
      pragmaHome: home,
      resolveVisibleExecutionIds: () => [executionId],
    });
    const context = withExecutionRunScope(undefined, { executionId });

    await expect(store.listContext({ context })).resolves.toMatchObject({
      ok: true,
      value: [{ id, sizeBytes: Buffer.byteLength(content) }],
    });
    await expect(store.readContext({ id, context })).resolves.toMatchObject({
      ok: true,
      value: { id, content },
    });
    await expect(store.searchContext({ query: "second", context })).resolves.toMatchObject({
      ok: true,
      value: [{ id, matchType: "content", lineNumber: 2 }],
    });
    await expect(store.addContext({ id: "new", content: "no", context })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(LEGACY_EXECUTION_OUTPUT_NAMESPACE).toBe("pragma.handoff");
  });

  it("does not expose outputs outside the Host-provided Mission visibility set", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-legacy-output-isolated-"));
    const store = new LegacyExecutionOutputContextStore({
      pragmaHome: home,
      resolveVisibleExecutionIds: () => [],
    });
    await expect(store.readContext({ id: "invocations/root/output.txt" })).resolves.toMatchObject({
      ok: false,
      error: { code: "context_not_found" },
    });
  });
});
