import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Capability } from "../../../../shared/desktop-api.ts";
import {
  CapabilityDirectoryFragment,
  capabilityDeleteErrorMessage,
  fieldsToObjectSchema,
} from "./CapabilityDirectoryFragment.tsx";

describe("code service field builder", () => {
  it("converts recursive object and array fields to a closed JSON Schema", () => {
    const fields: Parameters<typeof fieldsToObjectSchema>[0] = [
      {
        id: "records",
        name: "records",
        description: "Records to format.",
        required: true,
        value: {
          type: "array",
          fields: [],
          item: {
            type: "object",
            fields: [
              {
                id: "id",
                name: "id",
                description: "",
                required: true,
                value: { type: "string", fields: [] },
              },
            ],
          },
        },
      },
    ];

    expect(fieldsToObjectSchema(fields)).toEqual({
      type: "object",
      properties: {
        records: {
          type: "array",
          description: "Records to format.",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["records"],
      additionalProperties: false,
    });
  });
});

describe("capability row actions", () => {
  const capability: Capability = {
    manifest: {
      schemaVersion: "pragma.capability/v1",
      id: "00000000-0000-4000-8000-000000000000",
      runtimeKey: "test_skill_00000000",
      name: "Test Skill",
      kind: "skill",
      latestRevision: 1,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    },
    health: { revision: 1, status: "ready", checkedAt: "2026-07-11T00:00:00.000Z" },
    definition: {
      kind: "skill",
      name: "Test Skill",
      description: "Test capability actions.",
      entryPath: "SKILL.md",
      contentHash: "a".repeat(64),
    },
  };

  it("presents the overflow button as a menu trigger instead of a delete action", () => {
    const html = renderToStaticMarkup(
      <CapabilityDirectoryFragment
        capabilities={[capability]}
        onOpen={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="More actions for Test Skill"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-label="Delete Test Skill"');
  });

  it("maps referenced and unknown delete failures to friendly copy", () => {
    expect(capabilityDeleteErrorMessage("capability_referenced")).toContain(
      "still used by one or more Experts",
    );
    expect(capabilityDeleteErrorMessage()).toBe(
      "This capability could not be deleted. Please try again.",
    );
  });
});
