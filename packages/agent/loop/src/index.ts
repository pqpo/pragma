import { ExpertAgent } from "@expertmesh/agent-core";
import type { ExpertAgentCreateOptions } from "@expertmesh/agent-core";
import "@expertmesh/agent-runtime";

export async function defineAgent(options: ExpertAgentCreateOptions): Promise<ExpertAgent> {
  return await ExpertAgent.create(options);
}

export const agent = defineAgent;
