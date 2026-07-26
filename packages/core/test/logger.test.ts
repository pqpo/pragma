import { describe, expect, it, vi } from "vitest";

import {
  createCompositeLogHandler,
  createLoggerProvider,
  type PragmaLogRecord,
} from "../src/index.ts";

describe("Pragma logger", () => {
  it("creates validated operation and failure records with inherited scope", () => {
    const records: PragmaLogRecord[] = [];
    const provider = createLoggerProvider({
      handler: { write: (record) => records.push(record) },
      minimumLevel: "debug",
      host: {
        kind: "test",
        bootId: "00000000-0000-4000-8000-000000000001",
      },
      baseScope: { processKind: "test" },
    });
    const logger = provider
      .withScope({ executionId: "execution-1" })
      .createLogger({ component: "core.execution", scope: { invocationId: "invocation-1" } });

    logger.info("execution.started", "Execution started", {
      count: 1,
      accessToken: "must-not-leak",
    });
    const diagnosticId = logger.error("execution.failed", "Execution failed", new Error("boom"));

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      stream: "operation",
      level: "info",
      sequence: 0,
      scope: {
        processKind: "test",
        executionId: "execution-1",
        invocationId: "invocation-1",
      },
      attributes: { count: 1, accessToken: "[REDACTED]" },
    });
    expect(records[1]).toMatchObject({
      stream: "failure",
      level: "error",
      sequence: 1,
      diagnosticId,
      error: { name: "Error", message: "boom" },
    });
  });

  it("uses info as the default minimum level", () => {
    const records: PragmaLogRecord[] = [];
    const logger = createLoggerProvider({
      handler: { write: (record) => records.push(record) },
      host: { kind: "test" },
    }).createLogger({ component: "core.test" });

    logger.debug("test.debug", "Debug");
    logger.info("test.info", "Info");

    expect(records.map((record) => record.level)).toEqual(["info"]);
  });

  it("bounds each serialized record", () => {
    const records: PragmaLogRecord[] = [];
    const logger = createLoggerProvider({
      handler: { write: (record) => records.push(record) },
      host: { kind: "test" },
    }).createLogger({ component: "core.test" });

    logger.info(
      "test.large",
      "Large record",
      Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`field${index}`, "x".repeat(8_000)]),
      ),
    );

    expect(Buffer.byteLength(JSON.stringify(records[0]))).toBeLessThanOrEqual(64 * 1024);
    expect(records[0]?.attributes).toEqual({ recordTruncated: true });
  });

  it("bounds top-level messages and preserves the record byte limit", () => {
    const records: PragmaLogRecord[] = [];
    const logger = createLoggerProvider({
      handler: { write: (record) => records.push(record) },
      host: { kind: "test" },
    }).createLogger({ component: "core.test" });

    logger.info("test.large_message", "🧪".repeat(100_000));

    expect(Buffer.byteLength(JSON.stringify(records[0]))).toBeLessThanOrEqual(64 * 1024);
    expect(records[0]?.message.length).toBeLessThanOrEqual(8_192);
  });

  it("never lets hostile attribute or error getters escape into business code", () => {
    const records: PragmaLogRecord[] = [];
    const logger = createLoggerProvider({
      handler: { write: (record) => records.push(record) },
      host: { kind: "test" },
    }).createLogger({ component: "core.test" });
    const attributes = Object.defineProperty({}, "hostile", {
      enumerable: true,
      get: () => {
        throw new Error("attribute getter failed");
      },
    });
    const error = Object.defineProperty(new Error("boom"), "diagnosticId", {
      get: () => {
        throw new Error("diagnostic getter failed");
      },
    });

    expect(() => logger.info("test.hostile_attributes", "Still safe", attributes)).not.toThrow();
    expect(() => logger.error("test.hostile_error", "Still safe", error)).not.toThrow();

    expect(records[0]?.attributes).toEqual({ attributesUnserializable: true });
    expect(records[1]).toMatchObject({
      stream: "failure",
      error: { message: "boom" },
    });
  });

  it("does not allow child loggers to replace already-bound owner scope", () => {
    const records: PragmaLogRecord[] = [];
    const logger = createLoggerProvider({
      handler: { write: (record) => records.push(record) },
      host: { kind: "test" },
      baseScope: { executionId: "execution-1" },
    }).createLogger({ component: "plugin.test", scope: { pluginId: "plugin-1" } });

    logger
      .child({ scope: { executionId: "execution-other", invocationId: "invocation-1" } })
      .info("plugin.completed", "Plugin completed.");

    expect(records[0]?.scope).toMatchObject({
      executionId: "execution-1",
      pluginId: "plugin-1",
      invocationId: "invocation-1",
    });
  });

  it("settles every composite lifecycle branch even when one fails", async () => {
    const closed: string[] = [];
    const emergency = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createCompositeLogHandler([
      {
        write: () => undefined,
        close: async () => {
          closed.push("first");
          throw new Error("close failed");
        },
      },
      {
        write: () => undefined,
        close: async () => {
          await Promise.resolve();
          closed.push("second");
        },
      },
    ]);

    await expect(handler.close?.()).resolves.toBeUndefined();

    expect(closed).toEqual(["first", "second"]);
    expect(emergency).toHaveBeenCalledOnce();
    emergency.mockRestore();
  });

  it("isolates emergency reporting between independent providers", () => {
    const emergency = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let index = 0; index < 2; index += 1) {
      createLoggerProvider({
        handler: {
          write: () => {
            throw new Error("sink unavailable");
          },
        },
        host: { kind: "test" },
      })
        .createLogger({ component: "core.test" })
        .info("test.failed", "Sink fails.");
    }

    expect(emergency).toHaveBeenCalledTimes(2);
    emergency.mockRestore();
  });
});
