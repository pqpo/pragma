import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createStaticRuntimeResolver,
  defineRuntimeFeatures,
  runtimeFeature,
  type Expert,
} from "@pragma/core";
import {
  loadPragmaProject,
  type PragmaBindingRecord,
  type PragmaBundleBindingHost,
} from "@pragma/interpreter";

const expertRef = "expert:1xddvess309a6gme" as const;
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourceRoot = resolve(import.meta.dirname, "../../projects/bundle-transfer");
const outputRoot = resolve(repositoryRoot, "workspace/bundle-example");
const bundlePath = resolve(outputRoot, "portable-product-expert.pragma");

await mkdir(outputRoot, { recursive: true });

// 1. Load the authoring project and export only the Expert's transitive dependency closure.
const sourceProject = await loadPragmaProject(resolve(sourceRoot, "pragma.yaml"));
const sourceDiagnostics = await sourceProject.validateFor(expertRef);
if (sourceDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
  throw new Error(`Source project is invalid:\n${formatDiagnostics(sourceDiagnostics)}`);
}
const exported = await sourceProject.exportBundle({ roots: [expertRef] });
await writeFile(bundlePath, exported.bytes);

console.log(`Exported: ${bundlePath}`);
console.log(`Bundle version: ${exported.manifest.schemaVersion}`);
console.log(`Project fingerprint: ${exported.manifest.project.projectFingerprint}`);
console.log(
  `Requirements: ${exported.manifest.requirements.map((item) => `${item.kind}:${item.name}`).join(", ")}`,
);

// 2. Load the .pragma file directly. The Interpreter verifies and unpacks it internally.
const importedProject = await loadPragmaProject({
  kind: "bundle",
  source: { kind: "file", path: bundlePath },
});

try {
  console.log(
    `Loaded resources: ${importedProject
      .listResources()
      .map((resource) => `${resource.kind}:${resource.metadata.name}`)
      .join(", ")}`,
  );

  const compileHost = {
    workspace: outputRoot,
    pragmaHome: resolve(outputRoot, "pragma-home"),
  };
  const beforeBinding = await importedProject.prepareCompile<Expert>(expertRef, compileHost);
  console.log(`Before binding: ${beforeBinding.status}`);

  // 3. The destination Host explicitly binds machine-local Runtime and MCP assets.
  // Skill and knowledge files need no binding: they were transported as project artifacts.
  const boundRequirementIds = new Set<string>();
  const bindingHost: PragmaBundleBindingHost = {
    async inspect({ requirement }) {
      return {
        requirementId: requirement.id,
        status: boundRequirementIds.has(requirement.id) ? "ready" : "needs_binding",
        candidates: [
          {
            id: `example:${requirement.kind}`,
            name: `Example ${requirement.kind}`,
          },
        ],
      };
    },
    async bind({ requirement }) {
      boundRequirementIds.add(requirement.id);
      if (requirement.kind === "runtime") {
        return { runtimes: createExampleRuntimeResolver() };
      }
      if (requirement.kind === "binding") {
        const record: PragmaBindingRecord = {
          ref: `binding:pragma.bundle.${requirement.id}`,
          revision: "example-mcp-v1",
          fingerprint: "a".repeat(64),
          value: {
            transport: "streamable-http",
            url: "https://mcp.example.invalid/documentation",
          },
        };
        return { bindings: [record] };
      }
      return {};
    },
  };

  const binding = await importedProject.bindEnvironment(expertRef, bindingHost);
  const prepared = await importedProject.prepareCompile<Expert>(
    expertRef,
    compileHost,
    binding.overlay,
  );
  if (prepared.status !== "ready") {
    const diagnostics = "diagnostics" in prepared ? prepared.diagnostics : [];
    throw new Error(`Imported bundle is not executable:\n${formatDiagnostics(diagnostics)}`);
  }

  const expert = prepared.compiled.value;
  const contextIndex = await expert.contextSystem.index();
  if (!contextIndex.ok) throw new Error(contextIndex.error.message);

  console.log(`After binding: ${prepared.status}`);
  console.log(`Expert: ${expert.name}`);
  console.log(`Skills: ${expert.skills?.skills.map((skill) => skill.name).join(", ")}`);
  console.log(`MCP servers: ${Object.keys(expert.mcp?.mcpServers ?? {}).join(", ")}`);
  console.log(
    `Knowledge: ${contextIndex.value.items.map((item) => `${item.namespace}:${item.id}`).join(", ")}`,
  );
} finally {
  // Keep the project alive while using compiled Skill/knowledge paths, then release extracted files.
  await importedProject.dispose();
  await sourceProject.dispose();
}

function createExampleRuntimeResolver() {
  const omitted = () => runtimeFeature.notApplicable("The bundle example does not execute turns.");
  return createStaticRuntimeResolver({
    defaultRuntimeId: "example-runtime",
    runtimes: [
      {
        features: defineRuntimeFeatures({
          availability: runtimeFeature.degraded("The example uses a local availability stub."),
          authentication: omitted(),
          modelDiscovery: omitted(),
          modelSelection: omitted(),
          thinking: omitted(),
          freshSession: omitted(),
          resume: omitted(),
          systemPrompt: omitted(),
          startupMessages: omitted(),
          textStreaming: omitted(),
          reasoningStreaming: omitted(),
          nativeToolLifecycle: omitted(),
          mcp: omitted(),
          permissions: omitted(),
          userInteraction: omitted(),
          skills: omitted(),
          attachmentImage: omitted(),
          attachmentFile: omitted(),
          attachmentDirectory: omitted(),
          usage: omitted(),
          contextWindow: omitted(),
          compaction: omitted(),
          cancellation: omitted(),
          steering: omitted(),
          close: omitted(),
          cleanup: omitted(),
        }),
        descriptor: {
          id: "example-runtime",
          kind: "example",
          displayName: "Example Runtime",
        },
        canUse: () => ({ usable: true }),
      },
    ],
  });
}

function formatDiagnostics(
  diagnostics: readonly { readonly code: string; readonly message: string }[],
): string {
  return diagnostics.map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message}`).join("\n");
}
