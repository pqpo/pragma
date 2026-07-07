import { homedir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveMemoryDirectory } from "../src/storage.ts";
import { SkillMemoryConfigSchema } from "../src/index.ts";
import {
  resolveMemoryContextRoot,
  resolveSkillMemoryRoot,
} from "../src/memory-context/filesystem.ts";

describe("memory storage paths", () => {
  it("resolves default memory directories under the user home", () => {
    const path = resolveMemoryDirectory({
      category: "experience-memory",
      agentId: "agent/a",
    });

    expect(path).toBe(resolve(homedir(), ".pragma", "memories", "agent-a", "experience-memory"));
  });

  it("resolves shared memory context roots under the user home instead of the workspace", () => {
    const config = SkillMemoryConfigSchema.parse({});
    const path = resolveMemoryContextRoot("/tmp/workspace", config, "agent/a");

    expect(path).toBe(resolve(homedir(), ".pragma", "memories", "agent-a"));
  });

  it("resolves skill memory roots under the agent memory directory", () => {
    const config = SkillMemoryConfigSchema.parse({});
    const path = resolveSkillMemoryRoot("/tmp/workspace", config, "agent/a");

    expect(path).toBe(resolve(homedir(), ".pragma", "memories", "agent-a", "skill-memory"));
  });
});
