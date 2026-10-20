import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveDesktopSourceCommit } from "./build-desktop-cli.mjs";

test("development accepts source archives while builds require Git provenance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pragma-source-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(resolveDesktopSourceCommit(directory, { development: true }), null);
  assert.throws(() => resolveDesktopSourceCommit(directory), /require a Git checkout/);
});

test("an empty Git repository is usable only for development", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pragma-empty-checkout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", directory]);
  assert.equal(resolveDesktopSourceCommit(directory, { development: true }), null);
  assert.throws(() => resolveDesktopSourceCommit(directory), /require a Git checkout/);
});

test("development and builds retain the real source commit in a Git checkout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pragma-source-checkout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git(["init", "--quiet"]);
  git([
    "-c",
    "user.name=Pragma Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  assert.match(commit, /^[a-f0-9]{40,64}$/u);
  assert.equal(resolveDesktopSourceCommit(directory), commit);
  assert.equal(resolveDesktopSourceCommit(directory, { development: true }), commit);
});
