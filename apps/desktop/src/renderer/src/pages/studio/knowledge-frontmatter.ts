import { isMap, parseDocument, stringify } from "yaml";

export type KnowledgeMetadataEntry = readonly [field: string, value: string];

/** Presentation only: never rewrite the editable source or hide malformed frontmatter. */
export function splitKnowledgeFrontmatter(source: string): {
  body: string;
  entries: readonly KnowledgeMetadataEntry[];
} {
  const unchanged = { body: source, entries: [] };
  const match =
    /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/u.exec(source);
  if (match === null) return unchanged;
  try {
    const document = parseDocument(match[1]!, { uniqueKeys: true, intAsBigInt: true });
    if (document.errors.length > 0 || !isMap(document.contents)) return unchanged;
    const metadata: unknown = document.toJS({ maxAliasCount: 100, mapAsMap: true });
    if (!(metadata instanceof Map)) {
      return unchanged;
    }
    const entries = Array.from(metadata, ([field, value]): KnowledgeMetadataEntry => [
      stringify(field).trimEnd(),
      typeof value === "object" && value !== null ? stringify(value).trimEnd() : String(value),
    ]);
    return { body: source.slice(match[0].length), entries };
  } catch {
    return unchanged;
  }
}
