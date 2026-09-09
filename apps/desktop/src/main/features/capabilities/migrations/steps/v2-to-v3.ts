import { CapabilityCredentialsV2Schema } from "../schemas/v2.ts";
import { CapabilityCredentialsV3Schema } from "../schemas/v3.ts";

export const capabilityCredentialsV2ToV3Step = {
  fromVersion: 2,
  toVersion: 3,
  inputSchema: CapabilityCredentialsV2Schema,
  outputSchema: CapabilityCredentialsV3Schema,
  migrate(input: unknown) {
    const current = CapabilityCredentialsV2Schema.parse(input);
    return CapabilityCredentialsV3Schema.parse({
      schemaVersion: 3,
      credentials: Object.fromEntries(
        Object.entries(current.credentials).map(([key, ref]) => [
          key,
          { generation: ref.revision, ref },
        ]),
      ),
    });
  },
} as const;
