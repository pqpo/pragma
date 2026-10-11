import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("release reuses only latest trusted main success with complete artifacts; failures never fall back", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-verified-ci-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "source"), "fixture");
    execFileSync("git", ["add", "source"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=CI Test",
        "-c",
        "user.email=ci@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    await mkdir(join(root, "bin"));
    const gh = join(root, "bin/gh");
    await writeFile(
      gh,
      '#!/usr/bin/env node\nconst fs=require("node:fs");const state=JSON.parse(fs.readFileSync(process.env.TEST_STATE));process.stdout.write(JSON.stringify(process.argv[3].includes("/artifacts")?{artifacts:state.artifacts}:{workflow_runs:state.runs}));\n',
    );
    await chmod(gh, 0o755);
    const statePath = join(root, "state.json");
    const output = join(root, "output");
    const base = {
      id: 7,
      head_sha: sha,
      head_branch: "main",
      head_repository: { full_name: "test/pragma" },
      event: "push",
      status: "completed",
      conclusion: "success",
    };
    const artifacts = ["source-verification", "desktop-common", "pragma-cli-canonical"].map(
      (name) => ({ name, expired: false }),
    );
    async function invoke(runs, items = artifacts, extra = {}) {
      await writeFile(statePath, JSON.stringify({ runs, artifacts: items }));
      await writeFile(output, "");
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./find-verified-ci.mjs", import.meta.url))],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 5000,
          env: {
            ...process.env,
            PATH: `${join(root, "bin")}:${process.env.PATH}`,
            REUSE_CI: "true",
            GITHUB_REPOSITORY: "test/pragma",
            GITHUB_RUN_ID: "9",
            GITHUB_OUTPUT: output,
            TEST_STATE: statePath,
            ...extra,
          },
        },
      );
      return { ...result, output: await readFile(output, "utf8") };
    }
    let result = await invoke([base]);
    assert.equal(result.status, 0);
    assert.match(result.output, /reuse_run_id=7\n/);
    result = await invoke([{ ...base, id: 8, conclusion: "failure" }, base]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release blocked/);
    for (const changed of [
      { head_sha: "0".repeat(40) },
      { head_branch: "feature" },
      { event: "pull_request" },
      { head_repository: { full_name: "fork/pragma" } },
    ]) {
      result = await invoke([{ ...base, ...changed }]);
      assert.equal(result.status, 0);
      assert.match(result.output, /reuse_run_id=\nrun_id=9\n/);
    }
    result = await invoke(
      [base],
      artifacts.map((a) => ({ ...a, expired: true })),
    );
    assert.equal(result.status, 0);
    assert.match(result.output, /run_id=9/);
    const clock = join(root, "clock.mjs");
    await writeFile(
      clock,
      'let n=0;Object.defineProperty(globalThis,"performance",{value:{now:()=>n++*2000000}});',
    );
    result = await invoke([{ ...base, status: "in_progress" }], artifacts, {
      NODE_OPTIONS: `--import=${clock}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not finish in 30 minutes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
