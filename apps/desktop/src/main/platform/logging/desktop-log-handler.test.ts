import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoggerProvider, PragmaPaths } from "@pragma/core";
import { afterEach, describe, expect, it } from "vitest";

import { createDesktopLogHandler } from "./desktop-log-handler.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("Desktop log handler", () => {
  it("buffers until storage activation and separates operation and failure streams", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-log-"));
    roots.push(root);
    const paths = new PragmaPaths({ pragmaHome: root });
    const bootId = "00000000-0000-4000-8000-000000000001";
    const now = new Date("2026-07-26T12:00:00.000Z");
    const handler = createDesktopLogHandler({ paths, bootId, now: () => now });
    const logger = createLoggerProvider({
      handler,
      host: { kind: "desktop", bootId },
    }).createLogger({ component: "desktop.test" });

    logger.info("desktop.started", "Started");
    logger.error("desktop.failed", "Failed", new Error("boom"));
    await handler.activate();

    const directory = paths.diagnosticBootRoot("desktop", "2026-07-26", bootId);
    const operation = JSON.parse(
      (await readFile(join(directory, "operations-0001.jsonl"), "utf8")).trim(),
    ) as { stream: string };
    const failure = JSON.parse(
      (await readFile(join(directory, "errors-0001.jsonl"), "utf8")).trim(),
    ) as { stream: string; error: { message: string } };

    expect(operation.stream).toBe("operation");
    expect(failure).toMatchObject({ stream: "failure", error: { message: "boom" } });
    await handler.close();
  });

  it("never evicts buffered failures to admit a lower-priority operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-log-priority-"));
    roots.push(root);
    const paths = new PragmaPaths({ pragmaHome: root });
    const bootId = "00000000-0000-4000-8000-000000000002";
    const handler = createDesktopLogHandler({
      paths,
      bootId,
      maxBufferedRecords: 2,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    });
    const logger = createLoggerProvider({
      handler,
      host: { kind: "desktop", bootId },
    }).createLogger({ component: "desktop.test" });

    logger.error("desktop.failed_one", "Failed one", new Error("one"));
    logger.error("desktop.failed_two", "Failed two", new Error("two"));
    logger.info("desktop.started", "This lower-priority record must be dropped.");
    await handler.activate();

    const directory = paths.diagnosticBootRoot("desktop", "2026-07-26", bootId);
    const failures = (await readFile(join(directory, "errors-0001.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { error: { message: string } });

    expect(failures.map((record) => record.error.message)).toEqual(["one", "two"]);
    await expect(readFile(join(directory, "operations-0001.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await handler.close();
  });
});
