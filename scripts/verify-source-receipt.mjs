import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const receipt = JSON.parse(await readFile("verification.json", "utf8"));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const lockHash = createHash("sha256")
  .update(await readFile("pnpm-lock.yaml"))
  .digest("hex");
if (
  receipt.schemaVersion !== 1 ||
  receipt.commit !== sha ||
  receipt.lockHash !== lockHash ||
  receipt.node !== "22.19.0" ||
  receipt.pnpm !== "10.12.1" ||
  JSON.stringify(receipt.lanes) !== JSON.stringify(["quality", "business"])
)
  throw new Error("Invalid source verification receipt");
