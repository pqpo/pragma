import type { CapabilityDefinition, CapabilityHealth } from "../../../shared/contracts/index.ts";
import type { CapabilityCredentialReader } from "./capability-credential-store.ts";

export interface CapabilityVerifierResult {
  readonly definition: CapabilityDefinition;
  readonly health: Omit<CapabilityHealth, "revision">;
}

export type CapabilityVerifier = (
  definition: CapabilityDefinition,
  capabilityId: string,
  credentials?: CapabilityCredentialReader,
) => Promise<CapabilityVerifierResult>;
