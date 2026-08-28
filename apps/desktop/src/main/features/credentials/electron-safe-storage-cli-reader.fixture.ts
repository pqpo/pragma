import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createNativeOsKeychain, createSecretStore, type SecretRef } from "@pragma/local-host";

const root = process.argv.at(-1);
if (root === undefined) throw new Error("Expected an isolated root.");

const data = join(root, "data");
const credentials = join(data, "credentials");
const provider = JSON.parse(await readFile(join(data, "model-providers.json"), "utf8")) as {
  providers: readonly [{ apiKeySecretRef: SecretRef }];
};
const capability = JSON.parse(
  await readFile(join(credentials, "capability-credentials.json"), "utf8"),
) as { credentials: Record<string, SecretRef> };
const plugin = JSON.parse(await readFile(join(credentials, "plugin-credentials.json"), "utf8")) as {
  credentials: Record<string, SecretRef>;
};
const secretStore = createSecretStore({
  root: join(credentials, "secret-store"),
  dataRoot: data,
  keychain: createNativeOsKeychain(),
});

const digests = {
  provider: await digest(secretStore, provider.providers[0]!.apiKeySecretRef),
  capability: await digest(secretStore, capability.credentials["capability-e07/token"]!),
  plugin: await digest(secretStore, plugin.credentials["binding:e07"]!),
};
process.stdout.write(`${JSON.stringify({ digests })}\n`);
// The Electron run-as-node host can keep native handles alive after the CLI
// work has completed.  A real CLI exits at this boundary too; make the fixture
// deterministic so the parent can observe the completed process.
process.exit(0);

async function digest(
  store: ReturnType<typeof createSecretStore>,
  ref: SecretRef,
): Promise<string> {
  const handle = await store.get(ref);
  try {
    return createHash("sha256").update(handle.bytes()).digest("hex");
  } finally {
    handle.dispose();
  }
}
