import { homedir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveMemoryDirectory } from "../src/storage.ts";
import { SkillMemoryConfigSchema } from "../src/index.ts";
import { resolveMemoryRoot } from "../src/skill-memory/filesystem.ts";

describe("memory storage paths", () => {
  it("resolves default memory directories under the user home", () => {
    const path = resolveMemoryDirectory({
      category: "experience-memory",
      agentId: "agent/a",
    });

    expect(path).toBe(
      resolve(homedir(), ".pragma", "memories", "experience-memory", "agent-a"),
    );
  });

  it("resolves unified memory roots under the user home instead of the workspace", () => {
    const config = SkillMemoryConfigSchema.parse({});
    const path = resolveMemoryRoot("/tmp/workspace", config, "agent/a");

    expect(path).toBe(
      resolve(homedir(), ".pragma", "memories", "memory", "agent-a"),
    );
  });
});
