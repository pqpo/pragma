import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";

import {
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
  PragmaRuntimeProfileResourceSchema,
  canonicalPragmaResourceRef,
} from "@pragma/interpreter/ast";

import {
  bindExistingDesktopCapabilityResource,
  bindExistingDesktopContextResource,
  createDesktopCapabilityResource,
  resolveDesktopCapabilityResource,
  resolveDesktopContextResource,
  resolveDesktopRuntimeResource,
} from "./desktop-bound-resource-policy.ts";
import { desktopCapabilityBindingRef, desktopContextBindingRef } from "./desktop-binding-ref.ts";

const CAPABILITY_ID = "751a410b-4f80-4d0f-9db4-0efbe86afea7";

describe("desktop bound resource policy", () => {
  it("keeps the exact resource already referenced by an Expert", () => {
    const migrated = capability("nv27faxmxpqnxwqr", ["desktop-managed"], 3);
    const option = createDesktopCapabilityResource({
      owner: "default-agent-option",
      capabilityId: CAPABILITY_ID,
      revision: 3,
      name: "Search",
    });

    expect(
      resolveDesktopCapabilityResource({
        capabilityId: CAPABILITY_ID,
        revision: 3,
        resources: [option, migrated],
        currentRef: canonicalPragmaResourceRef(migrated),
      }),
    ).toEqual(migrated);
  });

  it("uses explicit owner precedence instead of source array order", () => {
    const migrated = capability("nv27faxmxpqnxwqr", ["desktop-managed"], 3);
    const option = createDesktopCapabilityResource({
      owner: "default-agent-option",
      capabilityId: CAPABILITY_ID,
      revision: 3,
      name: "Search",
    });
    for (const resources of [
      [migrated, option],
      [option, migrated],
    ]) {
      expect(
        resolveDesktopCapabilityResource({
          capabilityId: CAPABILITY_ID,
          revision: 3,
          resources,
        }),
      ).toEqual(option);
    }
  });

  it("fails closed when multiple non-canonical resources claim one binding", () => {
    expect(() =>
      resolveDesktopCapabilityResource({
        capabilityId: CAPABILITY_ID,
        revision: 3,
        resources: [
          capability("nv27faxmxpqnxwqr", ["desktop-managed"], 3),
          capability("ceq0qxcgdv75wg6b", ["desktop-managed"], 3),
        ],
      }),
    ).toThrow(/ambiguous/);
  });

  it("preserves imported metadata while adding host bindings", () => {
    const importedCapability = capability("ceq0qxcgdv75wg6b", [], 1);
    const rebound = bindExistingDesktopCapabilityResource(importedCapability, {
      id: CAPABILITY_ID,
      revision: 7,
    });
    expect(rebound.metadata).toEqual({
      ...importedCapability.metadata,
      tags: ["portable", "desktop-managed"],
    });

    const importedContext = PragmaContextStoreResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "ContextStore",
      metadata: {
        id: "1ymdp8c7rvxs4d3v",
        name: "Project docs",
        description: "Imported description",
        tags: ["portable"],
      },
      spec: { adapter: "portable.context@v1", config: { collection: "docs" } },
    });
    const boundContext = bindExistingDesktopContextResource(importedContext, "docs-store");
    expect(boundContext.metadata.id).toBe(importedContext.metadata.id);
    expect(boundContext.metadata.name).toBe("Project docs");
    expect(boundContext.spec.binding).toBe(desktopContextBindingRef("docs-store"));
  });

  it("reuses exact ContextStore and RuntimeProfile identities on no-op edits", () => {
    const context = PragmaContextStoreResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "ContextStore",
      metadata: {
        id: "r8ggx4n4219hrc2p",
        name: "Docs",
        description: "Migrated",
        tags: ["desktop-managed"],
      },
      spec: {
        adapter: "pragma.context.host@v1",
        binding: desktopContextBindingRef("docs-store"),
        config: { key: "docs-store" },
      },
    });
    expect(
      resolveDesktopContextResource({
        storeId: "docs-store",
        resources: [context],
        currentRef: canonicalPragmaResourceRef(context),
      }),
    ).toEqual(context);

    const runtime = PragmaRuntimeProfileResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: {
        id: "20k21q9j9wexjv50",
        name: "Remote",
        description: "Portable Runtime",
        tags: ["portable"],
      },
      spec: {
        adapter: "remote.runtime@v1",
        config: { runtimeId: "remote", providerId: "vendor", model: "model" },
      },
    });
    expect(
      resolveDesktopRuntimeResource({
        ownerId: "expert0000000001",
        ownerName: "Writer",
        model: { runtimeId: "remote", providerId: "vendor", modelId: "model" },
        resources: [runtime],
        currentRef: canonicalPragmaResourceRef(runtime),
      }),
    ).toEqual(runtime);
  });
});

function capability(id: string, tags: string[], revision: number) {
  return PragmaCapabilityResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Capability",
    metadata: {
      id,
      name: "Portable Search",
      description: "Preserve me",
      tags: ["portable", ...tags],
    },
    spec: {
      adapter: "pragma.capability.host@v1",
      binding: desktopCapabilityBindingRef(CAPABILITY_ID, revision),
      config: { key: CAPABILITY_ID },
    },
  });
}
