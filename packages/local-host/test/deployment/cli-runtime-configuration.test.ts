import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  createNativeOsKeychain,
  createSecretStore,
  readStoredModelProviderConfig,
  SECRET_STORE_SERVICE,
} from "../../src/index.ts";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PragmaPaths } from "@pragma/core";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaExpertResourceSchema,
  PragmaRuntimeProfileResourceSchema,
} from "@pragma/interpreter/ast";
import {
  createLocalHostRuntimeConfiguration,
  createPragmaProjectStore,
} from "../../src/deployment/index.ts";

const cli = fileURLToPath(new URL("../../../../apps/cli/dist/pragma.js", import.meta.url));
function invoke(home: string, args: readonly string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--json", "--interactive", "never"], {
      env: { ...process.env, PRAGMA_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
  "built CLI Runtime configuration and owner Worker",
  () => {
    it("uses a saved Environment and connection through the production process and queries the terminal", async () => {
      const home = await mkdtemp(join(tmpdir(), "pragma-cli-runtime-config-"));
      const requests: { model: string }[] = [];
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        expect(request.headers.authorization).toBe("Bearer production-configuration-canary");
        const input = JSON.parse(body) as { model: string };
        requests.push(input);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = {
          id: "config-test",
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
        };
        response.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "CONFIGURATION_CONFIRMED" }, finish_reason: null }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Missing test address");
        const configuration = createLocalHostRuntimeConfiguration({ pragmaHome: home });
        const provider = await configuration.modelProviders.create({
          presetId: "custom-openai",
          name: "Desktop test connection",
          protocol: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "production-configuration-canary",
          requiresApiKey: true,
          models: [
            {
              kind: "generation",
              id: "saved-model",
              name: "Saved model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 256,
              capabilitiesSource: "manual",
            },
          ],
        });
        const environment = await configuration.environments.create({
          schemaVersion: "pragma.runtime-environment/v1",
          id: "desktop-saved-pi",
          displayName: "Saved PI",
          origin: "registered",
          adapter: { id: "pragma.runtime.pi", version: "v1" },
          config: {},
        });
        const paths = new PragmaPaths({ pragmaHome: home });
        const project = createPragmaProjectStore({
          projectsPath: paths.projectsRoot(),
          objectsPath: paths.contentObjectsRoot(),
          projectViewsPath: paths.projectViewsCacheRoot(),
        });
        const metadata = (id: string) => ({
          id,
          name: "Configuration test",
          description: "Production CLI regression",
          tags: [],
        });
        const runtime = PragmaRuntimeProfileResourceSchema.parse({
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "RuntimeProfile",
          metadata: metadata("0000000000000399"),
          spec: {
            adapter: "pragma.runtime.profile@v1",
            config: {
              runtimeId: environment.runtimeId,
              providerId: provider.id,
              model: "saved-model",
            },
          },
        });
        const expert = PragmaExpertResourceSchema.parse({
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "Expert",
          metadata: metadata("0000000000000400"),
          spec: {
            scope: "Reply briefly",
            instructions: "Reply briefly",
            runtime: { ref: "runtime-profile:0000000000000399" },
            capabilities: [],
            toolApprovals: {},
            contextStores: [],
            plugins: [],
            tools: [],
          },
        });
        await project.publish({ expectedRevision: 0, resources: [runtime, expert] });
        const workspace = join(home, "workspace");
        await mkdir(workspace);
        const result = await invoke(home, [
          "expert",
          "run",
          "expert:0000000000000400",
          "--workspace",
          workspace,
          "--prompt",
          "Confirm configuration.",
          "--wait-timeout",
          "30",
        ]);
        expect(result.code, result.stdout + result.stderr).toBe(0);
        const run = JSON.parse(result.stdout);
        expect(run.status).toBe("succeeded");
        expect(result.stdout + result.stderr).not.toContain("production-configuration-canary");
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((request) => request.model === "saved-model")).toBe(true);
        const query = await invoke(home, ["mission", "get", run.missionId, "--view", "result"]);
        expect(query.code, query.stdout + query.stderr).toBe(0);
        expect(query.stdout).toContain("CONFIGURATION_CONFIRMED");
        const requestCount = requests.length;
        const saved = (await readStoredModelProviderConfig(paths.modelProviders())).providers.find(
          (entry) => entry.id === provider.id,
        )!;
        const ref = saved.apiKeySecretRef!;
        const secrets = createSecretStore({
          root: paths.secretStoreRoot(),
          dataRoot: paths.dataRoot(),
          keychain: createNativeOsKeychain(),
        });
        await secrets.delete(ref, ref.revision);
        const noCredential = await invoke(home, [
          "expert",
          "run",
          "expert:0000000000000400",
          "--workspace",
          workspace,
          "--prompt",
          "Credentials are missing.",
        ]);
        expect(noCredential.code).not.toBe(0);
        expect(JSON.parse(noCredential.stdout)).toMatchObject({
          status: "failed",
          error: { message: expect.stringContaining("saved API key") },
        });
        expect(noCredential.stdout + noCredential.stderr).not.toContain(
          "production-configuration-canary",
        );
        expect(requests.length).toBe(requestCount);
        // A selected model disappearing must fail before any transport request, never fall back.
        await configuration.modelProviders.remove(provider.id);
        const missing = await invoke(home, [
          "expert",
          "run",
          "expert:0000000000000400",
          "--project",
          "studio",
          "--revision",
          "1",
          "--workspace",
          workspace,
          "--prompt",
          "Must fail.",
        ]);
        expect(missing.code).not.toBe(0);
        expect(JSON.parse(missing.stdout)).toMatchObject({
          status: "failed",
          error: { code: "RUNTIME_UNAVAILABLE" },
        });
        expect(requests.length).toBe(requestCount);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        const account = `home:${createHash("sha256")
          .update(`${resolve(home, "data")}\u0000default`)
          .digest("hex")}:master-key:v1`;
        await createNativeOsKeychain().delete(SECRET_STORE_SERVICE, account);
        await rm(home, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
