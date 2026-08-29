import { PragmaLogRecordSchema } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import { createLocalHostStderrLoggerProvider } from "../src/index.ts";

describe("Local Host CLI logger", () => {
  it("writes structured diagnostics to the injected sink with sensitive fields redacted", () => {
    const lines: string[] = [];
    const provider = createLocalHostStderrLoggerProvider({
      write: (line) => lines.push(line),
    });
    const logger = provider.createLogger({ component: "cli.test" });

    logger.info("cli.test_info", "Diagnostic information", {
      apiKey: "api-key-must-not-leak",
      nested: { token: "token-must-not-leak" },
      visible: "kept",
    });
    logger.error("cli.test_error", "Diagnostic failure", new Error("failure detail"), {
      credential: "credential-must-not-leak",
    });

    const records = lines.map((line) => PragmaLogRecordSchema.parse(JSON.parse(line)));
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.host.kind === "cli")).toBe(true);
    expect(records[0]?.attributes).toMatchObject({
      apiKey: "[REDACTED]",
      nested: { token: "[REDACTED]" },
      visible: "kept",
    });
    expect(records[1]?.attributes).toMatchObject({ credential: "[REDACTED]" });
    expect(lines.join("\n")).not.toContain("must-not-leak");
  });
});
