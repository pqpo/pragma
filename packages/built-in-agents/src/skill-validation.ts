import { SkillPackageSchema, type SkillPackage } from "@pragma/shared";
import { parsePragmaYaml } from "@pragma/interpreter";

export interface SkillPackageValidationResult {
  readonly passed: boolean;
  readonly diagnostics: readonly {
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[];
}

export function validateSkillPackage(rawPackage: SkillPackage): SkillPackageValidationResult {
  const parsed = SkillPackageSchema.safeParse(rawPackage);
  if (!parsed.success) {
    const diagnostics = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    return { passed: false, diagnostics };
  }
  const diagnostics = metadataDiagnostics(parsed.data);
  return { passed: diagnostics.length === 0, diagnostics };
}

/** Whitespace is formatting in Skill descriptions and is ignored during metadata comparison. */
function normalizeDescription(value: string): string {
  return value.replace(/\s+/gu, "");
}

function metadataDiagnostics(
  skill: SkillPackage,
): readonly { readonly path: string; readonly code: string; readonly message: string }[] {
  const diagnostics: { path: string; code: string; message: string }[] = [];
  const skillDocument = skill.files.find((file) => file.path === "SKILL.md")?.content ?? "";
  const lines = skillDocument.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const openingDelimiter = lines[0]?.trimEnd();
  const closingDelimiter = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  let frontmatter: unknown;
  let frontmatterParsed = false;
  if (openingDelimiter !== "---" || closingDelimiter < 0) {
    diagnostics.push({
      path: "SKILL.md",
      code: "skill_frontmatter_invalid",
      message: "SKILL.md must start with YAML frontmatter delimited by --- lines.",
    });
  } else {
    try {
      frontmatter = parsePragmaYaml(lines.slice(1, closingDelimiter).join("\n"));
      frontmatterParsed = true;
    } catch (error) {
      diagnostics.push({
        path: "SKILL.md",
        code: "skill_frontmatter_invalid",
        message: `SKILL.md frontmatter is not valid YAML: ${
          error instanceof Error ? error.message : "Unknown YAML parsing error."
        }`,
      });
    }
  }
  if (frontmatterParsed) {
    if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
      diagnostics.push({
        path: "SKILL.md",
        code: "skill_frontmatter_invalid",
        message:
          "SKILL.md frontmatter must be a YAML object containing string name and description fields.",
      });
    } else {
      const parsedFields = frontmatter as Record<string, unknown>;
      for (const field of ["name", "description"] as const) {
        const value = parsedFields[field];
        if (typeof value !== "string") {
          diagnostics.push({
            path: `SKILL.md:${field}`,
            code: "skill_frontmatter_invalid",
            message: `SKILL.md frontmatter ${field} must be a YAML string.`,
          });
        } else if (
          field === "description"
            ? normalizeDescription(value) !== normalizeDescription(skill.description)
            : value.trim() !== skill.name
        ) {
          diagnostics.push({
            path: `SKILL.md:${field}`,
            code: "skill_metadata_mismatch",
            message: `SKILL.md frontmatter ${field} does not match the Skill metadata.yaml ${field}.`,
          });
        }
      }
    }
  }
  return diagnostics;
}
