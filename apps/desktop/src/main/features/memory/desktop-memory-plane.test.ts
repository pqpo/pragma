import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPragmaLogger, PragmaPaths } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { createDesktopMemoryPlane } from "./desktop-memory-plane.ts";

describe("DesktopMemoryPlane", () => {
  it("is an always-available host service whose background loop starts explicitly", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-desktop-memory-"));
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
      pollIntervalMs: 10,
    });

    await expect(plane.getStatus()).resolves.toMatchObject({
      state: "stopped",
      feed: { lastSequence: 0, eventCount: 0 },
      delivery: { pending: 0, quarantined: 0 },
      modules: [],
    });
    plane.start();
    await expect(plane.getStatus()).resolves.toMatchObject({ state: "running" });
    await plane.stop();
  });

  it("reports a quarantined handoff as degraded without exposing its payload", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-desktop-memory-degraded-"));
    const paths = new PragmaPaths({ pragmaHome });
    const handoff = paths.canonicalEventHandoff("execution", "future");
    await mkdir(paths.canonicalEventHandoffsRoot(), { recursive: true });
    await writeFile(
      handoff,
      JSON.stringify({ schemaVersion: "pragma.canonical-event-handoff/v2" }),
    );
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
      pollIntervalMs: 10,
    });

    plane.start();
    await vi.waitFor(async () => {
      await expect(plane.getStatus()).resolves.toMatchObject({
        state: "degraded",
        delivery: { pending: 0, quarantined: 1 },
        lastError: { code: "canonical_event_handoff_quarantined" },
      });
    });
    await plane.stop();
  });
});
