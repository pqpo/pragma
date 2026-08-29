import { ModelProvidersV4Schema } from "../schemas/v4.ts";

/** Credential bytes are deliberately not transformed here; the journaled adapter owns decryption. */
export const modelProvidersV4ToV5Step = { fromVersion: 4, toVersion: 5, inputSchema: ModelProvidersV4Schema } as const;
