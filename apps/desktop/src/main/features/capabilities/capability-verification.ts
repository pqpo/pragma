import type { CapabilityDefinition, CapabilityHealth } from "../../../shared/contracts/index.ts";

export interface CapabilityVerifierResult {
  readonly definition: CapabilityDefinition;
  readonly health: Omit<CapabilityHealth, "revision">;
}

export type CapabilityVerifier = (
  definition: CapabilityDefinition,
  capabilityId: string,
) => Promise<CapabilityVerifierResult>;
