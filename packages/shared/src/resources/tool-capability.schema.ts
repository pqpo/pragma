import { z } from "zod";

export type PragmaJsonSchema =
  | { readonly type: "string"; readonly description?: string | undefined }
  | { readonly type: "number"; readonly description?: string | undefined }
  | { readonly type: "integer"; readonly description?: string | undefined }
  | { readonly type: "boolean"; readonly description?: string | undefined }
  | {
      readonly type: "object";
      readonly description?: string | undefined;
      readonly properties: Readonly<Record<string, PragmaJsonSchema>>;
      readonly required?: readonly string[] | undefined;
      readonly additionalProperties: false;
    }
  | {
      readonly type: "array";
      readonly description?: string | undefined;
      readonly items: PragmaJsonSchema;
    };

const FieldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use a JavaScript-style field name.");
const DescriptionSchema = z.string().trim().max(500).optional();

export const PragmaJsonSchemaSchema: z.ZodType<PragmaJsonSchema> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("string"), description: DescriptionSchema }).strict(),
    z.object({ type: z.literal("number"), description: DescriptionSchema }).strict(),
    z.object({ type: z.literal("integer"), description: DescriptionSchema }).strict(),
    z.object({ type: z.literal("boolean"), description: DescriptionSchema }).strict(),
    z
      .object({
        type: z.literal("object"),
        description: DescriptionSchema,
        properties: z.record(FieldNameSchema, PragmaJsonSchemaSchema),
        required: z.array(FieldNameSchema).max(200).optional(),
        additionalProperties: z.literal(false),
      })
      .strict()
      .superRefine((schema, context) => {
        const properties = new Set(Object.keys(schema.properties));
        const required = schema.required ?? [];
        required.forEach((name, index) => {
          if (!properties.has(name)) {
            context.addIssue({
              code: "custom",
              message: `Required field ${name} must exist in properties.`,
              path: ["required", index],
            });
          }
          if (required.indexOf(name) !== index) {
            context.addIssue({
              code: "custom",
              message: `Required field ${name} must be unique.`,
              path: ["required", index],
            });
          }
        });
      }),
    z
      .object({
        type: z.literal("array"),
        description: DescriptionSchema,
        items: PragmaJsonSchemaSchema,
      })
      .strict(),
  ]),
);

export const PragmaObjectJsonSchemaSchema = PragmaJsonSchemaSchema.refine(
  (schema): schema is Extract<PragmaJsonSchema, { readonly type: "object" }> =>
    schema.type === "object",
  "The root schema must be an object.",
).superRefine((schema, context) => {
  const limits = schemaLimits(schema);
  if (limits.depth > 5) {
    context.addIssue({ code: "custom", message: "Schema nesting cannot exceed 5 levels." });
  }
  if (limits.fields > 200) {
    context.addIssue({ code: "custom", message: "Schema cannot contain more than 200 fields." });
  }
});

export const PragmaHttpParameterSchema = z.object({
  name: z.string().trim().min(1).max(100),
  location: z.enum(["path", "query"]),
  required: z.boolean(),
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string().trim().max(500).optional(),
});

export const PragmaHttpToolSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/, "Use letters, numbers, underscores, and hyphens."),
    description: z.string().trim().min(1).max(2_000),
    method: z.enum(["GET", "POST"]),
    path: z.string().trim().min(1).max(1_000).regex(/^\//, "Path must start with /"),
    parameters: z.array(PragmaHttpParameterSchema).max(100).default([]),
    bodySchema: PragmaObjectJsonSchemaSchema.optional(),
  })
  .superRefine((tool, context) => {
    if (tool.method === "GET" && tool.bodySchema !== undefined) {
      context.addIssue({
        code: "custom",
        message: "GET tools cannot declare a body.",
        path: ["bodySchema"],
      });
    }
    const declared = new Set(
      tool.parameters
        .filter((parameter) => parameter.location === "path")
        .map((parameter) => parameter.name),
    );
    for (const match of tool.path.matchAll(/\{([^}]+)\}/g)) {
      if (!declared.has(match[1] ?? "")) {
        context.addIssue({
          code: "custom",
          message: `Path parameter ${match[1]} must be declared.`,
          path: ["path"],
        });
      }
    }
  });

function schemaLimits(schema: PragmaJsonSchema): {
  readonly depth: number;
  readonly fields: number;
} {
  if (schema.type === "array") {
    const child = schemaLimits(schema.items);
    return { depth: child.depth + 1, fields: child.fields };
  }
  if (schema.type !== "object") return { depth: 1, fields: 0 };
  const children = Object.values(schema.properties).map(schemaLimits);
  return {
    depth: 1 + Math.max(0, ...children.map((child) => child.depth)),
    fields:
      Object.keys(schema.properties).length +
      children.reduce((sum, child) => sum + child.fields, 0),
  };
}
