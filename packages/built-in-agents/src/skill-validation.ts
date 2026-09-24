import { SkillPackageSchema, type SkillPackage } from "@pragma/shared";
const ALLOWED_NODE_IMPORTS = new Set([
  "node:assert",
  "node:assert/strict",
  "node:buffer",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:stream",
  "node:string_decoder",
  "node:test",
  "node:timers",
  "node:timers/promises",
  "node:url",
  "node:util",
]);

export interface SkillPackageValidationResult {
  readonly passed: boolean;
  readonly diagnostics: readonly {
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[];
}

export function validateSkillPackage(rawPackage: SkillPackage): SkillPackageValidationResult {
  return validatePackage(rawPackage, true);
}

export function validatePortableSkillPackage(
  rawPackage: SkillPackage,
): SkillPackageValidationResult {
  return validatePackage(rawPackage, false);
}

function validatePackage(
  rawPackage: SkillPackage,
  generated: boolean,
): SkillPackageValidationResult {
  const parsed = SkillPackageSchema.safeParse(rawPackage);
  if (!parsed.success) {
    const diagnostics = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    return { passed: false, diagnostics };
  }
  const diagnostics = staticDiagnostics(parsed.data, generated);
  return { passed: diagnostics.length === 0, diagnostics };
}

function staticDiagnostics(
  skill: SkillPackage,
  generated: boolean,
): readonly { readonly path: string; readonly code: string; readonly message: string }[] {
  const diagnostics: { path: string; code: string; message: string }[] = [];
  const skillDocument = skill.files.find((file) => file.path === "SKILL.md")?.content ?? "";
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/u.exec(skillDocument)?.[1] ?? "";
  const frontmatterName = /^name:\s*["']?([^\n"']+)["']?\s*$/mu.exec(frontmatter)?.[1]?.trim();
  const frontmatterDescription = /^description:\s*["']?([^\n"']+)["']?\s*$/mu
    .exec(frontmatter)?.[1]
    ?.trim();
  if (frontmatterName !== skill.name || frontmatterDescription !== skill.description) {
    diagnostics.push({
      path: "SKILL.md",
      code: "skill_metadata_mismatch",
      message: "SKILL.md frontmatter name and description must match the Skill package metadata.",
    });
  }
  if (generated) {
    skill.files.forEach((file) => {
      if (
        file.path !== "SKILL.md" &&
        !file.path.startsWith("references/") &&
        !file.path.startsWith("scripts/") &&
        !file.path.startsWith("tests/")
      ) {
        diagnostics.push({
          path: file.path,
          code: "skill_file_location_invalid",
          message:
            "Generated Skill files must be SKILL.md or live under references/, scripts/, or tests/.",
        });
      }
      if (
        (file.path.startsWith("scripts/") || file.path.startsWith("tests/")) &&
        !file.path.endsWith(".mjs")
      ) {
        diagnostics.push({
          path: file.path,
          code: "skill_executable_extension_invalid",
          message: "Generated executable files must be Node ESM .mjs files.",
        });
      }
    });
  }
  const scripts = generated ? skill.files.filter((file) => file.path.startsWith("scripts/")) : [];
  const tests = generated ? skill.files.filter((file) => file.path.startsWith("tests/")) : [];
  if (generated && scripts.length > 0 && tests.length === 0) {
    diagnostics.push({
      path: "tests/",
      code: "skill_script_tests_missing",
      message: "Generated scripts require node:test coverage.",
    });
  }
  const testedImports = new Set(
    tests.flatMap((file) =>
      extractImports(file.content)
        .filter((specifier) => specifier.startsWith("../scripts/"))
        .map((specifier) => normalizeTestImport(file.path, specifier)),
    ),
  );
  for (const script of scripts) {
    if (!testedImports.has(script.path)) {
      diagnostics.push({
        path: script.path,
        code: "skill_script_uncovered",
        message: `${script.path} is not imported by a test.`,
      });
    }
  }
  for (const file of skill.files.filter((entry) => /\.(?:mjs|cjs|js)$/iu.test(entry.path))) {
    if (/\bimport\s*\(/u.test(file.content) || /\brequire\s*\(/u.test(file.content)) {
      diagnostics.push({
        path: file.path,
        code: "skill_dynamic_module_loading_forbidden",
        message: `${file.path} uses dynamic module loading.`,
      });
    }
    if (/\b(?:fetch|WebSocket|EventSource)\s*\(/u.test(file.content)) {
      diagnostics.push({
        path: file.path,
        code: "skill_network_access_forbidden",
        message: `${file.path} uses a network API.`,
      });
    }
    if (/\bprocess\s*\.\s*(?:binding|_linkedBinding|mainModule)\b/u.test(file.content)) {
      diagnostics.push({
        path: file.path,
        code: "skill_process_escape_forbidden",
        message: `${file.path} uses a forbidden process escape API.`,
      });
    }
    for (const specifier of extractImports(file.content)) {
      if (specifier.startsWith(".") || ALLOWED_NODE_IMPORTS.has(specifier)) continue;
      diagnostics.push({
        path: file.path,
        code: "skill_import_forbidden",
        message: `${file.path} imports forbidden module ${specifier}.`,
      });
    }
  }
  return diagnostics;
}

function extractImports(content: string): readonly string[] {
  return [
    ...content.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/gu),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function normalizeTestImport(testPath: string, specifier: string): string {
  const segments = [...testPath.split("/").slice(0, -1), ...specifier.split("/")];
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") normalized.pop();
    else normalized.push(segment);
  }
  return normalized.join("/");
}
