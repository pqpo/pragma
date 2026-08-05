import { createHash } from "node:crypto";

import {
  KnowledgeShareSchema,
  type Knowledge,
  type KnowledgeShare,
  type KnowledgeShareProvenance,
} from "@pragma/shared";

export function createKnowledgeShare(input: {
  readonly knowledge: Knowledge;
  readonly sourceProjectFingerprint: string;
  readonly provenance: readonly KnowledgeShareProvenance[];
}): KnowledgeShare {
  const payload = {
    schemaVersion: "pragma.memory-knowledge-share/v1" as const,
    sourceProjectFingerprint: input.sourceProjectFingerprint,
    sourceRef: { id: input.knowledge.id, revision: input.knowledge.revision },
    content: input.knowledge.content,
    rootRef: input.knowledge.rootRef,
    producerRefs: input.knowledge.producerRefs,
    visibility: input.knowledge.visibility,
    sensitivity: input.knowledge.sensitivity,
    bindings: input.knowledge.bindings,
    sourceDigest: input.knowledge.sourceDigest,
    provenance: input.provenance,
  };
  return KnowledgeShareSchema.parse({ ...payload, digest: shareDigest(payload) });
}

export function assertKnowledgeShareDigest(share: KnowledgeShare): void {
  const { digest, ...payload } = share;
  if (shareDigest(payload) !== digest) throw new Error("knowledge_import_digest_mismatch");
}

function shareDigest(payload: object): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
