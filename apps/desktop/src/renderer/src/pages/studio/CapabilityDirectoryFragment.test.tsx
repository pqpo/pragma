import { describe, expect, it } from "vitest";

import { fieldsToObjectSchema } from "./CapabilityDirectoryFragment.tsx";

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
