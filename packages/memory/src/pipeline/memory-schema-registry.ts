import { AgentMessageSchema, type MemoryEvidenceEnvelope } from "@pragma/shared";
import { z } from "zod";

export class MemorySchemaRegistry {
  private readonly schemas = new Map<string, z.ZodType>();

  register(input: {
    readonly topic: string;
    readonly schemaRef: string;
    readonly schema: z.ZodType;
  }): void {
    const key = schemaKey(input.topic, input.schemaRef);
    if (this.schemas.has(key)) throw new Error(`Duplicate Memory payload schema: ${key}`);
    this.schemas.set(key, input.schema);
  }

  supports(topic: string, schemaRef: string): boolean {
    return this.schemas.has(schemaKey(topic, schemaRef));
  }

  validate(envelope: MemoryEvidenceEnvelope): boolean {
    return (
      this.schemas.get(schemaKey(envelope.topic, envelope.schemaRef))?.safeParse(envelope.payload)
        .success === true
    );
  }
}

export function createBuiltInMemorySchemaRegistry(): MemorySchemaRegistry {
  const registry = new MemorySchemaRegistry();
  registry.register({
    topic: "execution.message.appended",
    schemaRef: "pragma.memory.execution-message/v1",
    schema: z.object({ message: AgentMessageSchema }),
  });
  for (const scope of ["invocation", "execution"] as const) {
    registry.register({
      topic: `execution.${scope}.terminal`,
      schemaRef: `pragma.memory.${scope}-terminal/v1`,
      schema: z.object({ outcome: z.string().min(1), data: z.unknown() }),
    });
  }
  for (const phase of ["started", "completed", "failed"] as const) {
    registry.register({
      topic: `execution.tool.${phase}`,
      schemaRef: "pragma.memory.tool-event/v1",
      schema: z
        .object({
          toolCallId: z.string().min(1),
          toolName: z.string().min(1),
          contentCompleteness: z.enum(["full", "preview", "reference-only"]),
        })
        .passthrough(),
    });
  }
  registry.register({
    topic: "artifact.created",
    schemaRef: "pragma.memory.artifact-event/v1",
    schema: z.object({ artifactId: z.string().min(1), kind: z.string().min(1) }).passthrough(),
  });
  registry.register({
    topic: "artifact.handoff.registered",
    schemaRef: "pragma.memory.handoff-artifact/v1",
    schema: z.object({ context: z.unknown() }).passthrough(),
  });
  return registry;
}

function schemaKey(topic: string, schemaRef: string): string {
  return `${topic}\0${schemaRef}`;
}
