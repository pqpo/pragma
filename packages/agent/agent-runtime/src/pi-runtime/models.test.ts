import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { writePiModelConfig } from "./models.ts";

describe("writePiModelConfig", () => {
  it("writes PI models.json from ExpertMesh provider config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "expertmesh-pi-models-"));

    const configPath = await writePiModelConfig(cwd, "agent-1", [
      {
        provider: "openai",
        modelNames: ["gpt-4o", "gpt-4.1"],
        baseApi: "https://api.openai.com/v1",
        key: "$OPENAI_API_KEY",
      },
    ]);

    expect(configPath).toBeDefined();
    if (configPath === undefined) {
      throw new Error("Expected config path");
    }

    const content = JSON.parse(await readFile(configPath, "utf-8")) as unknown;

    expect(content).toEqual({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: "$OPENAI_API_KEY",
          models: [{ id: "gpt-4o" }, { id: "gpt-4.1" }],
        },
      },
    });
  });
});
