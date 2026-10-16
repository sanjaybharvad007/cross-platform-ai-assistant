import { z } from "zod";
import type { JsonSchema } from "../providers/types.js";

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const d = schema.description;
  const w = (j: JsonSchema): JsonSchema => (d ? { ...j, description: d } : j);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) return w(zodToJsonSchema(schema._def.innerType));
  if (schema instanceof z.ZodString) return w({ type: "string" });
  if (schema instanceof z.ZodNumber) return w({ type: schema._def.checks.some((c: { kind: string }) => c.kind === "int") ? "integer" : "number" });
  if (schema instanceof z.ZodBoolean) return w({ type: "boolean" });
  if (schema instanceof z.ZodEnum) return w({ type: "string", enum: [...(schema._def.values as string[])] });
  if (schema instanceof z.ZodArray) return w({ type: "array", items: zodToJsonSchema(schema._def.type) });
  if (schema instanceof z.ZodObject) {
    const props: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      props[k] = zodToJsonSchema(v);
      if (!(v instanceof z.ZodOptional || v instanceof z.ZodDefault)) required.push(k);
    }
    return w({ type: "object", properties: props, ...(required.length ? { required } : {}) });
  }
  throw new Error(`unsupported zod type: ${schema.constructor.name}`);
}
