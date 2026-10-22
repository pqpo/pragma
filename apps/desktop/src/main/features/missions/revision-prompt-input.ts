import { PragmaPaths } from "@pragma/core";
import type { ExpertPromptAttachment } from "@pragma/shared";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Keep large task inputs outside both Mission goals and publishable draft payloads. */
export async function prepareRevisionPromptInput(input: {
  readonly pragmaHome: string;
  readonly goal: string;
}): Promise<{
  readonly goal: string;
  readonly attachments?: readonly ExpertPromptAttachment[];
  readonly copyFileAttachments?: boolean;
}> {
  if (input.goal.length <= 100_000) return { goal: input.goal };
  const root = join(
    new PragmaPaths({ pragmaHome: input.pragmaHome }).temporaryRoot(),
    "revision-inputs",
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Temporary staging only: Mission creation atomically copies this input into its owner tree.
  // Its durable manifest never retains this GC-managed path.
  const path = join(root, `${createHash("sha256").update(input.goal).digest("hex")}.md`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, input.goal, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    goal: "Read the attached revision-request.md in full before editing. It contains the complete revision request, source evidence, and draft instructions. Follow those instructions and submit the draft for review.",
    copyFileAttachments: true,
    attachments: [
      {
        id: randomUUID(),
        kind: "file",
        name: "revision-request.md",
        path,
        mimeType: "text/markdown",
        size: Buffer.byteLength(input.goal, "utf8"),
      },
    ],
  };
}
