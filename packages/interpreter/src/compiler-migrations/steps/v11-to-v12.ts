import { parseCurrentProject } from "../validate-project.ts";

/** Preserve source policies and validate the real v11 lock before recompilation. */
export function migratePragmaCompilerV11Project(input: {
  readonly files: ReadonlyMap<string, string>;
}) {
  return parseCurrentProject(input.files, "pragma.dsl/v11");
}
