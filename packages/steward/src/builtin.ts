import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { BUILT_IN_STEWARD_FILES } from "./builtin.generated.ts";

export const BUILT_IN_STEWARD_REF = "expert:steward@1.0.0" as const;

export function builtInStewardFingerprint(): string {
  const hash = createHash("sha256");
  for (const [path, source] of Object.entries(BUILT_IN_STEWARD_FILES).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(path);
    hash.update("\0");
    hash.update(source);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function materializeBuiltInSteward(root: string): Promise<string> {
  const targetRoot = join(root, builtInStewardFingerprint());
  for (const [relativePath, source] of Object.entries(BUILT_IN_STEWARD_FILES)) {
    const target = join(targetRoot, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, source, { mode: 0o600 });
  }
  return join(targetRoot, "pragma.yaml");
}
