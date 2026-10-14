export { CapabilityCredentialsV1Schema } from "./schemas/v1.ts";
export { CapabilityCredentialsV2Schema } from "./schemas/v2.ts";
import { CapabilityCredentialsV3Schema } from "./schemas/v3.ts";
import { capabilityCredentialsV1ToV2Step } from "./steps/v1-to-v2.ts";
import { capabilityCredentialsV2ToV3Step } from "./steps/v2-to-v3.ts";

export { CapabilityCredentialBindingSchema } from "./schemas/v3.ts";
export {
  CapabilityCredentialsV3Schema,
  capabilityCredentialsV1ToV2Step,
  capabilityCredentialsV2ToV3Step,
};

export const capabilityCredentialStorageVersions = {
  currentVersion: CapabilityCredentialsV3Schema.shape.schemaVersion.value,
  migratableVersions: [
    capabilityCredentialsV1ToV2Step.fromVersion,
    capabilityCredentialsV2ToV3Step.fromVersion,
  ],
} as const;
