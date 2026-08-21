import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const versionSource = readFileSync(
  resolve(import.meta.dirname, "../src/ast/pragma-api-version.ts"),
  "utf8",
);
const match = /PRAGMA_DSL_WRITE_API_VERSION\s*=\s*"([^"]+)"/u.exec(versionSource);
if (match === null) throw new Error("Cannot read PRAGMA_DSL_WRITE_API_VERSION.");

const literal = `"${match[1]}"`;
let output = "";
try {
  output = execFileSync("git", ["grep", "-n", "-F", literal, "--", "*.ts", "*.tsx"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
} catch (error) {
  if (typeof error === "object" && error !== null && "status" in error && error.status === 1) {
    process.exit(0);
  }
  throw error;
}

const allowed = [
  "packages/interpreter/src/ast/pragma-api-version.ts",
  "packages/interpreter/src/migrations/",
  "packages/interpreter/src/compiler-migrations/",
  "packages/built-in-agents/src/builtin.generated.ts",
];
const violations = output
  .trim()
  .split("\n")
  .filter((line) => line !== "")
  .filter((line) => !allowed.some((prefix) => line.startsWith(prefix)));

if (violations.length > 0) {
  process.stderr.write(
    [
      "Current Pragma DSL apiVersion literals must use PRAGMA_DSL_WRITE_API_VERSION:",
      ...violations,
      "",
    ].join("\n"),
  );
  process.exit(1);
}
