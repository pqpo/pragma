import { z } from "zod";

export const ExpertPromptAttachmentKindSchema = z.enum(["image", "file", "directory"]);

export const ExpertPromptAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    kind: ExpertPromptAttachmentKindSchema,
    name: z.string().trim().min(1).max(255),
    path: z.string().trim().min(1).max(4_096),
    mimeType: z.string().trim().min(1).max(255).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .superRefine((attachment, context) => {
    if (attachment.kind === "image" && attachment.mimeType === undefined) {
      context.addIssue({
        code: "custom",
        path: ["mimeType"],
        message: "Image attachments require a MIME type.",
      });
    }
  });

export const ExpertPromptInputSchema = z
  .object({
    text: z.string().min(1),
    attachments: z.array(ExpertPromptAttachmentSchema).max(20).default([]),
  })
  .strict();

export type ExpertPromptAttachmentKind = z.infer<typeof ExpertPromptAttachmentKindSchema>;
export type ExpertPromptAttachment = z.infer<typeof ExpertPromptAttachmentSchema>;
export type ExpertPromptInput = z.infer<typeof ExpertPromptInputSchema>;
