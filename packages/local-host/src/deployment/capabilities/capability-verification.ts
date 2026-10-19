import type { CapabilityStore } from "./capability-store.ts";
import type { CapabilityDefinition, CapabilityHealth } from "../../deployment-contracts/index.ts";
import type { CapabilityCredentialReader } from "../../resources/capability-credential-store.ts";

export interface CapabilityVerifierResult {
  readonly definition: CapabilityDefinition;
  readonly health: Omit<CapabilityHealth, "revision">;
}

export type CapabilityVerifier = (
  definition: CapabilityDefinition,
  capabilityId: string,
  credentials?: CapabilityCredentialReader,
) => Promise<CapabilityVerifierResult>;

/** Binding follows the active revision; unactivated assets remain available for explicit setup. */
export async function resolveCapabilityForBinding(
  store: Pick<CapabilityStore, "resolveActive" | "get">,
  id: string,
) {
  try {
    return await store.resolveActive(id);
  } catch (error) {
    const latest = await store.get(id);
    if (latest.health.status === "ready") throw error;
    return latest;
  }
}
