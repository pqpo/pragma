import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRuntimeProbeEvidence,
  RuntimeProbeEvidenceSchema,
  writeRuntimeProbeEvidence,
} from "../src/runtime/probe-evidence.ts";
import { PragmaPaths } from "../src/storage/pragma-paths.ts";

describe("Runtime probe evidence", () => {
  it("irreversibly redacts credentials and managed paths before validation", () => {
    const evidence = createEvidence({
      observations: [
        "Bearer secret-token-value",
        "workspace=/private/work/project home=/private/home cache=/private/cache/runtime",
      ],
      command: {
        executable: "/private/home/bin/runtime",
        arguments: ["--api-key", "secret-token-value"],
      },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toContain("/private/work/project");
    expect(serialized).not.toContain("/private/home");
    expect(serialized).not.toContain("/private/cache/runtime");
    expect(serialized).toContain("[redacted:sha256:");
    expect(RuntimeProbeEvidenceSchema.parse(evidence)).toEqual(evidence);
  });

  it("writes validated evidence atomically below archives/runtime-probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-probe-evidence-"));
    const path = await writeRuntimeProbeEvidence(createEvidence(), {
      paths: new PragmaPaths({ pragmaHome: root }),
      fileName: "probe.json",
    });
    expect(path).toContain(join("archives", "runtime-probes"));
    expect(RuntimeProbeEvidenceSchema.parse(JSON.parse(await readFile(path, "utf8")))).toBeTruthy();
  });
});

function createEvidence(overrides: Partial<Parameters<typeof createRuntimeProbeEvidence>[0]> = {}) {
  return createRuntimeProbeEvidence(
    {
      runtime: { id: "test-runtime", kind: "test", version: "1.0.0" },
      probe: { id: "stream", version: "v1" },
      environment: {
        capturedAt: "2026-08-13T00:00:00.000Z",
        platform: "test",
        architecture: "test",
      },
      command: { executable: "runtime", arguments: ["probe"] },
      assertions: [
        {
          id: "stream.executed",
          feature: "textStreaming",
          stage: "executed",
          status: "passed",
          message: "Observed ordered deltas.",
        },
      ],
      observations: [],
      ...overrides,
    },
    {
      home: "/private/home",
      workspace: "/private/work/project",
      paths: ["/private/cache/runtime"],
      secrets: ["secret-token-value"],
    },
  );
}
