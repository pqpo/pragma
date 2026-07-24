import { z } from "zod";

export const AutomationPlacementSchema = z.enum(["desktop", "server", "either"]);
export const AutomationSourceModeSchema = z.enum(["signal", "conversation"]);
export const AutomationInteractionModeSchema = z.enum(["reuse-session", "new-mission"]);

export const AutomationEventEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("pragma.automation-event/v1"),
    eventId: z.string().trim().min(1).max(500),
    automationRef: z.string().trim().min(1).max(500),
    source: z
      .object({
        adapterRef: z.string().trim().min(1).max(500),
        bindingRef: z.string().trim().min(1).max(500),
      })
      .strict(),
    kind: AutomationSourceModeSchema,
    occurredAt: z.string().datetime({ offset: true }),
    conversationKey: z.string().trim().min(1).max(2_000).optional(),
    payload: z.unknown(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.kind === "conversation" && event.conversationKey === undefined) {
      context.addIssue({
        code: "custom",
        message: "Conversation events require a conversationKey.",
        path: ["conversationKey"],
      });
    }
  });

export type AutomationPlacement = z.infer<typeof AutomationPlacementSchema>;
export type AutomationSourceMode = z.infer<typeof AutomationSourceModeSchema>;
export type AutomationInteractionMode = z.infer<typeof AutomationInteractionModeSchema>;
export type AutomationEventEnvelope = z.infer<typeof AutomationEventEnvelopeSchema>;

export interface AutomationAdapterDescriptor {
  readonly ref: string;
  readonly name: string;
  readonly description: string;
  readonly sourceMode: AutomationSourceMode;
  readonly placement: AutomationPlacement;
  readonly requiresConnection: boolean;
  readonly supportsSessionReuse: boolean;
  readonly configSchema: Readonly<Record<string, unknown>>;
  readonly credentialSchema?: Readonly<Record<string, unknown>> | undefined;
}

export interface AutomationSourceHealth {
  readonly status: "ready" | "needs_attention";
  readonly checkedAt: string;
  readonly message?: string | undefined;
}

export interface AutomationSourceAdapter {
  readonly descriptor: AutomationAdapterDescriptor;
  inspect(): Promise<AutomationSourceHealth>;
  start(emit: (event: AutomationEventEnvelope) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface AutomationDispatchRequest {
  readonly event: AutomationEventEnvelope;
  readonly interactionMode: AutomationInteractionMode;
  readonly continuityKey: string;
}

export interface AutomationDelivery {
  readonly status?: string | undefined;
  readonly finalText?: string | undefined;
  readonly artifactRefs?: readonly string[] | undefined;
}
