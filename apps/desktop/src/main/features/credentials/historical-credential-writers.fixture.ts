import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Portable copies of the credential serialization performed by commit bcd2ed01
 * (the last Desktop revision before M5). These writers intentionally retain
 * the former schema and safeStorage-byte layout so migration tests consume data
 * emitted by historical code instead of objects with a rewritten version field.
 */
export const HISTORICAL_CREDENTIAL_WRITER_COMMIT = "bcd2ed01";

export async function writeHistoricalModelProviderV4(input: {
  readonly path: string;
  readonly providerId: string;
  readonly apiKey: string;
}): Promise<void> {
  await writeHistoricalJson(input.path, {
    schemaVersion: 4,
    providers: [
      {
        id: input.providerId,
        presetId: "openai",
        name: "Historical OpenAI",
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [
          {
            id: "gpt-4.1",
            name: "GPT 4.1",
            api: "openai-responses",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 16_384,
            capabilitiesSource: "manual",
          },
        ],
        encryptedApiKey: historicalSafeStorageEncrypt(input.apiKey),
        requiresApiKey: true,
        verification: { status: "unverified" },
        revision: 1,
      },
    ],
  });
}

export async function writeHistoricalCapabilityCredentialsV1(
  path: string,
  credentials: Readonly<Record<string, string>>,
): Promise<void> {
  await writeHistoricalJson(path, {
    schemaVersion: 1,
    credentials: Object.fromEntries(
      Object.entries(credentials).map(([key, value]) => [key, historicalSafeStorageEncrypt(value)]),
    ),
  });
}

export async function writeHistoricalPluginCredentialsV1(
  path: string,
  credentials: Readonly<Record<string, string>>,
): Promise<void> {
  await writeHistoricalJson(path, {
    schemaVersion: 1,
    credentials: Object.fromEntries(
      Object.entries(credentials).map(([key, value]) => [key, historicalSafeStorageEncrypt(value)]),
    ),
  });
}

export function historicalSafeStorageDecrypt(ciphertext: Uint8Array): Uint8Array {
  const encoded = Buffer.from(ciphertext).toString("utf8");
  if (!encoded.startsWith("encrypted:")) throw new Error("legacy ciphertext is corrupted");
  return Buffer.from(encoded.slice("encrypted:".length));
}

function historicalSafeStorageEncrypt(value: string): string {
  // Frozen from bcd2ed01's historical test double: its returned bytes are then
  // base64 encoded exactly as the v4/v1 store writers persisted them.
  return Buffer.from(`encrypted:${value}`).toString("base64");
}

async function writeHistoricalJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.historical-writer.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
