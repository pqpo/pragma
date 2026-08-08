import {
  ExpertPromptInputSchema,
  type ExpertPromptAttachment,
  type ExpertPromptInput,
} from "@pragma/shared";

export function createExpertPromptInput(
  text: string,
  attachments: readonly ExpertPromptAttachment[],
): ExpertPromptInput {
  return ExpertPromptInputSchema.parse({ text, attachments });
}

export function readExpertPromptInput(input: unknown, fallbackText: string): ExpertPromptInput {
  if (input === undefined) {
    return ExpertPromptInputSchema.parse({ text: fallbackText, attachments: [] });
  }
  if (typeof input === "string") {
    return ExpertPromptInputSchema.parse({ text: input, attachments: [] });
  }
  const parsed = ExpertPromptInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(`Expert prompt input is invalid: ${parsed.error.message}`);
}

export function formatExpertPromptWithAttachments(
  text: string,
  attachments: readonly ExpertPromptAttachment[],
): string {
  if (attachments.length === 0) return text;

  const sections: string[] = [];
  appendAttachmentSection(sections, "Images mentioned by the user", attachments, "image");
  appendAttachmentSection(sections, "Files mentioned by the user", attachments, "file");
  appendAttachmentSection(sections, "Directories mentioned by the user", attachments, "directory");
  sections.push(["# My request", text].join("\n"));
  return sections.join("\n\n");
}

function appendAttachmentSection(
  sections: string[],
  title: string,
  attachments: readonly ExpertPromptAttachment[],
  kind: ExpertPromptAttachment["kind"],
): void {
  const matching = attachments.filter((attachment) => attachment.kind === kind);
  if (matching.length === 0) return;
  sections.push(
    [
      `# ${title}:`,
      ...matching.map(
        (attachment) =>
          `## ${escapePromptLine(attachment.name)}: ${escapePromptLine(attachment.path)}`,
      ),
    ].join("\n"),
  );
}

function escapePromptLine(value: string): string {
  return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}
