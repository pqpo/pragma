import {
  InvocationOutputSchema,
  type ContextInvocationOutput,
  type InvocationOutput,
} from "@pragma/shared";

import {
  ContextSystem,
  type ExpertAgentContextStoreRegistrationInput,
} from "../context-system/context-system.ts";
import { withExecutionRunScope } from "../runtime/run-context.ts";
import { encodePragmaPathSegment } from "../storage/pragma-paths.ts";

export const DEFAULT_CONTEXT_OUTPUT_INLINE_LIMIT_BYTES = 32 * 1024;
export const DEFAULT_CONTEXT_OUTPUT_SUMMARY_LIMIT_BYTES = 4 * 1024;

export class ContextOutputService {
  readonly inlineLimitBytes: number;
  readonly summaryLimitBytes: number;

  constructor(
    readonly executionId: string,
    private readonly contextSystem: ContextSystem,
    options: {
      readonly inlineLimitBytes?: number | undefined;
      readonly summaryLimitBytes?: number | undefined;
    } = {},
  ) {
    this.inlineLimitBytes = normalizeLimit(
      options.inlineLimitBytes,
      DEFAULT_CONTEXT_OUTPUT_INLINE_LIMIT_BYTES,
    );
    this.summaryLimitBytes = normalizeLimit(
      options.summaryLimitBytes,
      DEFAULT_CONTEXT_OUTPUT_SUMMARY_LIMIT_BYTES,
    );
  }

  async normalize(
    invocationId: string,
    contextId: string,
    output: unknown,
  ): Promise<InvocationOutput> {
    const serialized = serializeOutput(output);
    if (serialized.bytes.byteLength <= this.inlineLimitBytes) {
      return InvocationOutputSchema.parse({
        type: "inline",
        value: output === undefined ? null : output,
      });
    }

    const namespace = this.contextSystem.overflowTargetNamespace;
    if (namespace === undefined) {
      throw new Error("Large Invocation output requires exactly one Context overflow target.");
    }
    const extension = serialized.mediaType === "application/json" ? "json" : "txt";
    const id = `system/outputs/${encodePragmaPathSegment(this.executionId)}/${encodePragmaPathSegment(invocationId)}.${extension}`;
    const context = withExecutionRunScope(undefined, {
      executionId: this.executionId,
      invocationId,
      contextId,
    });
    let stored = await this.contextSystem.add({
      namespace,
      id,
      content: Buffer.from(serialized.bytes).toString("utf8"),
      context,
    });
    if (!stored.ok && stored.error.code === "context_already_exists") {
      const existing = await this.contextSystem.read({ namespace, id, context });
      if (!existing.ok) throw new Error(existing.error.message);
      stored = await this.contextSystem.edit({
        namespace,
        id,
        mode: "replace",
        content: Buffer.from(serialized.bytes).toString("utf8"),
        expectedRevision: existing.value.revision,
        expectedEtag: existing.value.etag,
        context,
      });
    }
    if (!stored.ok) throw new Error(`[${stored.error.code}] ${stored.error.message}`);
    if (stored.value.revision === undefined) {
      throw new Error(`Context overflow target did not return a revision: ${namespace}/${id}`);
    }

    const normalized = InvocationOutputSchema.parse({
      type: "context",
      summary: summarizeOutput(output, serialized.mediaType, this.summaryLimitBytes),
      contexts: [
        {
          namespace,
          id,
          revision: stored.value.revision,
          sizeBytes: stored.value.sizeBytes ?? serialized.bytes.byteLength,
          mediaType: serialized.mediaType,
        },
      ],
    });
    return normalized;
  }
}

export function createContextOutputSystem(
  bindings: readonly ExpertAgentContextStoreRegistrationInput[] | undefined,
): ContextSystem {
  const system = new ContextSystem();
  for (const binding of bindings ?? []) {
    const result = system.register(binding);
    if (!result.ok) throw new TypeError(result.error.message);
  }
  return system;
}

export function unwrapInvocationOutput(output: InvocationOutput): unknown {
  return output.type === "inline" ? output.value : output;
}

export function isContextInvocationOutput(value: unknown): value is ContextInvocationOutput {
  const parsed = InvocationOutputSchema.safeParse(value);
  return parsed.success && parsed.data.type === "context";
}

function serializeOutput(output: unknown): {
  readonly bytes: Uint8Array;
  readonly mediaType: "text/plain" | "application/json";
} {
  if (typeof output === "string")
    return { bytes: Buffer.from(output, "utf8"), mediaType: "text/plain" };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(output === undefined ? null : output);
  } catch (error) {
    throw new Error("Invocation output is not JSON-serializable.", { cause: error });
  }
  if (serialized === undefined) throw new Error("Invocation output is not JSON-serializable.");
  return { bytes: Buffer.from(serialized, "utf8"), mediaType: "application/json" };
}

function summarizeOutput(output: unknown, mediaType: string, limitBytes: number): string {
  if (typeof output !== "string")
    return `Large ${mediaType} output is available through the attached Context reference.`;
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= limitBytes) return output;
  let end = limitBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n\n[Context output summary truncated.]`;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0)
    throw new Error("Context output byte limits must be positive safe integers.");
  return normalized;
}
