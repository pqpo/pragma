/* global Buffer, process */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, safeStorage } from "electron";

const [implementationPath, action, root] = process.argv.slice(-3);
if (
  implementationPath === undefined ||
  root === undefined ||
  (action !== "write" && action !== "migrate" && action !== "cleanup")
) {
  throw new Error(
    "Expected implementation path, write, migrate, or cleanup, and an isolated root.",
  );
}

app.setName("Pragma Desktop");
const userData = join(root, "electron-user-data");
await mkdir(userData, { recursive: true, mode: 0o700 });
app.setPath("userData", userData);

void app
  .whenReady()
  .then(async () => {
    try {
      if (action !== "cleanup" && !safeStorage.isEncryptionAvailable()) {
        throw new Error("Electron safeStorage is unavailable in this environment.");
      }
      if (action === "write") await writeHistoricalCredentialData(root);
      else if (action === "migrate") {
        const implementation = await import(pathToFileURL(implementationPath).href);
        await implementation.migrateHistoricalCredentialData(root);
      } else {
        const implementation = await import(pathToFileURL(implementationPath).href);
        await implementation.deleteSecretStoreMasterKey(root);
      }
      process.stdout.write(`${JSON.stringify({ action, safeStorage: "available" })}\n`);
    } finally {
      app.quit();
    }
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    app.exit(1);
  });

async function writeHistoricalCredentialData(dataRoot) {
  const data = join(dataRoot, "data");
  const credentials = join(data, "credentials");
  const providerId = "31a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6";
  await writeJson(join(data, "model-providers.json"), {
    schemaVersion: 4,
    providers: [
      {
        id: providerId,
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
        encryptedApiKey: encrypt("e07-provider-secret"),
        requiresApiKey: true,
        verification: { status: "unverified" },
        revision: 1,
      },
    ],
  });
  await writeJson(join(credentials, "capability-credentials.json"), {
    schemaVersion: 1,
    credentials: {
      "capability-e07/token": encrypt("e07-capability-secret"),
    },
  });
  await writeJson(join(credentials, "plugin-credentials.json"), {
    schemaVersion: 1,
    credentials: {
      "binding:e07": encrypt("e07-plugin-secret"),
    },
  });
}

function encrypt(value) {
  return Buffer.from(safeStorage.encryptString(value)).toString("base64");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
