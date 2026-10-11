import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const repo = process.env.GITHUB_REPOSITORY;
const api = (path) =>
  JSON.parse(
    execFileSync("gh", ["api", `repos/${repo}/${path}`], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
let runId = "";
if (process.env.REUSE_CI === "true") {
  const deadline = performance.now() + 30 * 60_000;
  while (true) {
    const run = api(`actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`)
      .workflow_runs.filter(
        (r) =>
          r.head_sha === sha &&
          r.head_branch === "main" &&
          r.event === "push" &&
          r.head_repository?.full_name === repo,
      )
      .sort((a, b) => b.id - a.id)[0];
    if (!run) break;
    if (run.status !== "completed") {
      if (performance.now() >= deadline)
        throw new Error(
          `CI ${run.id} did not finish in 30 minutes; source validation was not duplicated.`,
        );
      console.log(`Waiting for trusted main CI ${run.id} (${run.status})`);
      await setTimeout(30_000);
      continue;
    }
    if (run.conclusion !== "success")
      throw new Error(`Trusted main CI ${run.id} concluded ${run.conclusion}; release blocked.`);
    const artifacts = api(`actions/runs/${run.id}/artifacts?per_page=100`).artifacts;
    const required = [
      "source-verification",
      "desktop-common",
      "workspace-build",
      "pragma-cli-canonical",
    ];
    if (
      required.every((name) => artifacts.filter((a) => a.name === name && !a.expired).length === 1)
    )
      runId = String(run.id);
    else
      console.log(
        "Verified CI artifacts have expired or are incomplete; rebuilding and validating the source.",
      );
    break;
  }
}
await appendFile(
  process.env.GITHUB_OUTPUT,
  `source_sha=${sha}\nreuse_run_id=${runId}\nrun_id=${runId || process.env.GITHUB_RUN_ID}\n`,
);
