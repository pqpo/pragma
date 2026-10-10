import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

test("worker requires an external CLI and preserves it across managed-policy initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-claude-worker-"));
  try {
    const worker = join(root, "worker.mjs");
    const policy = fileURLToPath(
      new URL(
        "../../../packages/runtime/claude-code/node_modules/@agentclientprotocol/claude-agent-acp/dist/managed-policy.js",
        import.meta.url,
      ),
    );
    await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            "../../../packages/runtime/claude-code/src/claude-acp-worker.ts",
            import.meta.url,
          ),
        ),
      ],
      outfile: worker,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["@napi-rs/keyring", "bufferutil", "utf-8-validate"],
      banner: {
        js: 'import { createRequire as __pragmaCreateRequire } from "node:module"; const require = __pragmaCreateRequire(import.meta.url);',
      },
      plugins: [
        {
          name: "managed-policy-fixture",
          setup(builder) {
            builder.onResolve(
              { filter: /^@agentclientprotocol\/claude-agent-acp\/dist\/managed-policy\.js$/ },
              () => ({ path: "fixture", namespace: "policy-fixture" }),
            );
            builder.onLoad({ filter: /.*/, namespace: "policy-fixture" }, () => ({
              // Exercise the real policy env merger with a deterministic policy source.
              contents: `import { applyManagedPolicyEnv as apply } from ${JSON.stringify(policy)};
                export async function applyManagedPolicyEnv() {
                  await apply(async () => ({ effective: { env: {
                    CLAUDE_CODE_EXECUTABLE: process.env.PRAGMA_TEST_POLICY_CLI ?? "",
                    PRAGMA_TEST_POLICY_APPLIED: "yes"
                  } } }));
                }`,
              resolveDir: root,
            }));
          },
        },
      ],
    });
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_CODE_EXECUTABLE: "",
      PRAGMA_TEST_POLICY_CLI: "",
    };
    const version = await run(worker, ["--version"], env);
    assert.equal(version.code, 0);
    const runtimePackage = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL("../../../packages/runtime/claude-code/package.json", import.meta.url),
        ),
        "utf8",
      ),
    );
    assert.equal(
      version.stdout.trim(),
      runtimePackage.dependencies["@agentclientprotocol/claude-agent-acp"],
    );
    for (const value of ["", "   "]) {
      const result = await run(worker, [], { ...env, CLAUDE_CODE_EXECUTABLE: value });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Install Claude Code yourself/);
    }
    if (process.platform === "win32") return;

    const external = join(root, "User Installed Claude");
    await writeFile(
      external,
      '#!/bin/sh\nprintf "%s" "$PRAGMA_TEST_POLICY_APPLIED" > "$PRAGMA_TEST_CLI_MARKER"\nprintf \'{}\\n\'\n',
    );
    await chmod(external, 0o755);
    for (const [index, policyCli] of ["", join(root, "unvalidated-cli")].entries()) {
      const marker = join(root, `invoked-${index}`);
      const result = await run(
        worker,
        [],
        {
          ...env,
          CLAUDE_CODE_EXECUTABLE: external,
          PRAGMA_TEST_POLICY_CLI: policyCli,
          PRAGMA_TEST_CLI_MARKER: marker,
        },
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1, clientCapabilities: {} },
        })}\n`,
      );
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout.split("\n").some((line) => line && JSON.parse(line).id === 1));
      assert.equal(await readFile(marker, "utf8"), "yes");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function run(worker, args, env, input) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Claude worker timed out: ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      // Initialization's auth probe confirms which CLI was actually invoked.
      if (input && /auth status (?:returned unparseable output|failed:)/.test(chunk))
        child.stdin.end();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    if (input) child.stdin.write(input);
    else child.stdin.end();
  });
}
