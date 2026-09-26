import { parseDocument, stringify } from "yaml";
import { PragmaDslError } from "./project-error.ts";

export function formatPragmaYaml(value: unknown): string {
  return stringify(value, { lineWidth: 100 });
}

export function parsePragmaYaml(source: string): unknown {
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new PragmaDslError(document.errors.map((error) => error.message).join("\n"));
  }
  return document.toJS({ maxAliasCount: 50 });
}
