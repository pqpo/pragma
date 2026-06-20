import {
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ExpertAgent } from "@expertmesh/agent-core";
import { dirname } from "node:path";

export function createResourceLoader(
  agent: ExpertAgent,
  cwd: string,
  systemPrompt: string,
): DefaultResourceLoader {
  const skills = createPiSkills(agent);

  return new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [...base, systemPrompt],
    skillsOverride: (base) => ({
      skills: [...base.skills, ...skills],
      diagnostics: base.diagnostics,
    }),
  });
}

function createPiSkills(agent: ExpertAgent): Skill[] {
  return (agent.skills?.skills ?? [])
    .filter((skill) => skill.path !== undefined)
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.path as string,
      baseDir: skill.baseDir ?? dirname(skill.path as string),
      sourceInfo: createSyntheticSourceInfo(skill.path as string, {
        source: skill.type,
        baseDir: skill.baseDir ?? dirname(skill.path as string),
      }),
      disableModelInvocation: false,
    }));
}
