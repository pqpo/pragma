import type { OpenCodePermissionRule } from "./client.ts";

export type OpenCodePermissionMode = "request-approval" | "auto-approve" | "full-access";

/** Never let an approved shell inherit the loopback password or provider credentials. */
export function v1Permission(
  mode: OpenCodePermissionMode,
  denials: Record<string, unknown>,
): Record<string, unknown> {
  if (denials["*"] === "deny") return { "*": "deny" };
  const safe: Record<string, unknown> =
    mode === "full-access"
      ? { "*": "allow" }
      : {
          "*": "deny",
          read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
          glob: "allow",
          grep: "allow",
          edit: mode === "auto-approve" ? "allow" : "ask",
          external_directory: "deny",
          bash: "deny",
          task: "deny",
          question: "allow",
          "pragma_tools_*": "allow",
          ...(mode === "request-approval" ? { webfetch: "ask", websearch: "ask" } : {}),
        };
  for (const [action, denial] of Object.entries(denials)) {
    if (denial === "deny") safe[action] = "deny";
    else if (typeof denial === "object" && denial !== null && !Array.isArray(denial)) {
      if ((denial as Record<string, unknown>)["*"] === "deny") {
        safe[action] = "deny";
        continue;
      }
      safe[action] = {
        ...(typeof safe[action] === "object"
          ? (safe[action] as object)
          : { "*": safe[action] ?? safe["*"] ?? "deny" }),
        ...denial,
      };
    }
  }
  return safe;
}

export function v2PermissionRules(
  mode: OpenCodePermissionMode,
  denials: readonly OpenCodePermissionRule[],
): readonly OpenCodePermissionRule[] {
  const rule = (action: string, effect: OpenCodePermissionRule["effect"], resource = "*") => ({
    action,
    resource,
    effect,
  });
  const base =
    mode === "full-access"
      ? [rule("*", "allow")]
      : [
          rule("*", "deny"),
          rule("read", "allow"),
          rule("read", "deny", "*.env"),
          rule("read", "deny", "*.env.*"),
          rule("read", "allow", "*.env.example"),
          rule("glob", "allow"),
          rule("grep", "allow"),
          rule("edit", mode === "auto-approve" ? "allow" : "ask"),
          rule("external_directory", "deny"),
          rule("shell", "deny"),
          rule("execute", "deny"),
          rule("subagent", "deny"),
          rule("question", "allow"),
          rule("pragma_tools_*", "allow"),
          ...(mode === "request-approval"
            ? [rule("webfetch", "ask"), rule("websearch", "ask")]
            : []),
        ];
  return [...base, ...denials];
}
