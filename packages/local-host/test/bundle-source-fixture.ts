import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatPragmaYaml, loadPragmaProject } from "@pragma/interpreter";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";

export async function createExpertBundle(
  root: string,
  outputPath = join(root, "reviewer.pragma"),
): Promise<string> {
  const projectPath = join(root, "project.yaml");
  await writeFile(
    projectPath,
    formatPragmaYaml({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Bundle",
      resources: [
        {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "RuntimeProfile",
          metadata: {
            id: "knr7p5b7qc55wv92",
            name: "Runtime",
            description: "Runtime",
            tags: [],
          },
          spec: { adapter: "pragma.runtime.profile@v1", config: { runtimeId: "codex" } },
        },
        {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "Expert",
          metadata: {
            id: "1xddvess309a6gme",
            name: "Reviewer",
            description: "Reviews code",
            tags: ["review"],
          },
          spec: {
            scope: "review",
            instructions: "Review code.",
            runtime: { ref: "runtime-profile:knr7p5b7qc55wv92" },
            capabilities: [],
            toolApprovals: {},
            contextStores: [],
            plugins: [],
            tools: [],
          },
        },
      ],
    }),
  );
  const project = await loadPragmaProject(projectPath);
  try {
    const exported = await project.exportBundle({ roots: ["expert:1xddvess309a6gme"] });
    await writeFile(outputPath, exported.bytes);
    return outputPath;
  } finally {
    await project.dispose();
  }
}
