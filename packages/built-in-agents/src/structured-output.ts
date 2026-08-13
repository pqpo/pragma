export function extractStructuredJson(content: string): string {
  return inspectStructuredJson(content).content;
}

export interface StructuredJsonInspection {
  readonly content: string;
  readonly closingBoundaryFound: boolean;
}

export function inspectStructuredJson(content: string): StructuredJsonInspection {
  const trimmed = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const objectStart = candidate.indexOf("{");
  const arrayStart = candidate.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length === 0) return { content: candidate, closingBoundaryFound: false };

  const start = Math.min(...starts);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) break;
      stack.pop();
      if (stack.length === 0) {
        return {
          content: candidate.slice(start, index + 1).trim(),
          closingBoundaryFound: true,
        };
      }
    }
  }
  return { content: candidate.slice(start).trim(), closingBoundaryFound: false };
}
