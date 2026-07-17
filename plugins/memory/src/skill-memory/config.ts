import type { ExpertAgentPluginSetupContext } from "@pragma/core";

import { SkillMemoryConfigSchema } from "./schema.ts";
import type { SkillMemoryConfig } from "./schema.ts";
import { describeConfigInput } from "./config-utils.ts";

export async function resolveConfig(
  context: ExpertAgentPluginSetupContext,
): Promise<SkillMemoryConfig> {
  return SkillMemoryConfigSchema.parse(readConfigObject(context.userConfig));
}

function readConfigObject(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  throw new Error(`Skill memory config must be an object, received ${describeConfigInput(input)}.`);
}
