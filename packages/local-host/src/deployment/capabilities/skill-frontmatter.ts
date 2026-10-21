import { parsePragmaYaml } from "@pragma/interpreter";

export function readSkillFrontmatter(content: string): { name?: string; description?: string } {
  const lines = content.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (lines[0]?.trimEnd() !== "---" || end < 0) return {};
  try {
    const metadata = parsePragmaYaml(lines.slice(1, end).join("\n"));
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return {};
    const fields = metadata as Record<string, unknown>;
    return {
      ...(typeof fields["name"] === "string" ? { name: fields["name"].trim() } : {}),
      ...(typeof fields["description"] === "string"
        ? { description: fields["description"].trim() }
        : {}),
    };
  } catch {
    // The package validator returns path-addressed frontmatter diagnostics.
    return {};
  }
}
