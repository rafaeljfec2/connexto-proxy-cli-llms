import type { OpenAiToolSpec, ToolParameterSchemaShape } from "../types.js";
import { isRecord } from "../common.js";
import { firstMatchingProperty } from "./aliases.js";
import { normalizeToolName } from "./specs.js";

export function wrapperObjectPropertyCandidates(): string[] {
  return ["input", "args", "arguments", "params", "parameters", "payload", "data"];
}

export function toolParameterSchema(
  tool: OpenAiToolSpec | undefined,
): ToolParameterSchemaShape {
  return toolParameterSchemaFromValue(tool?.parameters);
}

export function toolParameterSchemaFromValue(
  value: unknown,
  depth = 0,
  root: unknown = value,
  seenRefs: Set<string> = new Set(),
): ToolParameterSchemaShape {
  if (depth > 5) return emptyToolParameterSchema();
  const parameters = canonicalToolSchemaRecord(value, root, depth, seenRefs);
  if (!parameters) return emptyToolParameterSchema();

  const direct = directToolParameterSchema(parameters, root, depth, seenRefs);
  const allOf = composedToolSchemas(parameters.allOf).map((schema) =>
    toolParameterSchemaFromValue(schema, depth + 1, root, seenRefs),
  );
  const variants = [
    ...composedToolSchemas(parameters.anyOf),
    ...composedToolSchemas(parameters.oneOf),
  ].map((schema) => toolParameterSchemaFromValue(schema, depth + 1, root, seenRefs));

  return mergeToolParameterSchemas(
    [
      direct,
      mergeToolParameterSchemas(allOf, "union"),
      mergeToolParameterSchemas(variants, "intersection"),
    ],
    "union",
  );
}

export function emptyToolParameterSchema(): ToolParameterSchemaShape {
  return {
    properties: [],
    required: [],
    allowAdditionalProperties: false,
    propertySchemas: {},
  };
}

export function canonicalToolSchemaRecord(
  value: unknown,
  root: unknown,
  depth = 0,
  seenRefs: Set<string> = new Set(),
): Record<string, unknown> | undefined {
  if (depth > 5) return undefined;
  const dereferenced = dereferenceToolSchema(value, root, depth, seenRefs);
  if (!isRecord(dereferenced)) return undefined;
  if (!isRecord(dereferenced.properties)) {
    if (isRecord(dereferenced.schema))
      return canonicalToolSchemaRecord(dereferenced.schema, root, depth + 1, seenRefs);
    if (isRecord(dereferenced.json_schema))
      return canonicalToolSchemaRecord(
        dereferenced.json_schema,
        root,
        depth + 1,
        seenRefs,
      );
  }
  return dereferenced;
}

export function directToolParameterSchema(
  parameters: Record<string, unknown>,
  root: unknown,
  depth: number,
  seenRefs: Set<string>,
): ToolParameterSchemaShape {
  const properties = isRecord(parameters.properties)
    ? parameters.properties
    : undefined;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((item): item is string => typeof item === "string")
    : [];
  const propertySchemas = properties
    ? Object.fromEntries(
        Object.entries(properties).map(([key, schema]) => [
          key,
          dereferenceToolSchema(schema, root, depth + 1, seenRefs),
        ]),
      )
    : {};
  return {
    properties: properties ? Object.keys(properties) : [],
    required,
    allowAdditionalProperties:
      parameters.additionalProperties === true ||
      isRecord(parameters.additionalProperties),
    propertySchemas,
  };
}

export function composedToolSchemas(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function dereferenceToolSchema(
  value: unknown,
  root: unknown,
  depth = 0,
  seenRefs: Set<string> = new Set(),
): unknown {
  if (depth > 5 || !isRecord(value) || typeof value.$ref !== "string") return value;
  const ref = value.$ref.trim();
  if (!ref || seenRefs.has(ref)) return value;
  const target = localSchemaReference(root, ref);
  if (target === undefined || target === value) return value;
  return dereferenceToolSchema(target, root, depth + 1, new Set([...seenRefs, ref]));
}

export function localSchemaReference(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  const direct = jsonPointerTarget(root, ref);
  if (direct !== undefined) return direct;
  if (!isRecord(root)) return undefined;
  return (
    jsonPointerTarget(root.schema, ref) ?? jsonPointerTarget(root.json_schema, ref)
  );
}

export function jsonPointerTarget(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const token of ref.slice(2).split("/").map(jsonPointerToken)) {
    if (Array.isArray(current)) {
      const index = Number(token);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[token];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

export function jsonPointerToken(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function mergeToolParameterSchemas(
  shapes: ToolParameterSchemaShape[],
  requiredMode: "union" | "intersection",
): ToolParameterSchemaShape {
  const useful = shapes.filter(
    (shape) =>
      shape.properties.length ||
      shape.required.length ||
      shape.allowAdditionalProperties,
  );
  if (!useful.length) return emptyToolParameterSchema();
  const propertySchemas: Record<string, unknown> = {};
  const properties: string[] = [];
  for (const shape of useful) {
    for (const property of shape.properties) {
      if (!properties.includes(property)) properties.push(property);
      propertySchemas[property] =
        propertySchemas[property] === undefined
          ? shape.propertySchemas[property]
          : mergePropertySchemas(
              propertySchemas[property],
              shape.propertySchemas[property],
            );
    }
  }
  const required =
    requiredMode === "intersection"
      ? intersectRequiredProperties(useful.map((shape) => shape.required))
      : Array.from(new Set(useful.flatMap((shape) => shape.required)));
  return {
    properties,
    required,
    allowAdditionalProperties: useful.some((shape) => shape.allowAdditionalProperties),
    propertySchemas,
  };
}

export function mergePropertySchemas(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) return left ?? right;
  const merged: Record<string, unknown> = { ...right, ...left };
  const enumValues = unionStringArrays(
    left.enum,
    right.enum,
    left.const === undefined ? undefined : [left.const],
    right.const === undefined ? undefined : [right.const],
  );
  if (enumValues.length) {
    merged.enum = enumValues;
    if (enumValues.length > 1) delete merged.const;
  }
  if (merged.description === undefined && typeof right.description === "string")
    merged.description = right.description;
  return merged;
}

export function unionStringArrays(...values: unknown[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && !output.includes(item)) output.push(item);
    }
  }
  return output;
}

export function intersectRequiredProperties(requiredSets: string[][]): string[] {
  const nonEmpty = requiredSets.filter((required) => required.length > 0);
  if (!nonEmpty.length) return [];
  return nonEmpty[0].filter((property) =>
    nonEmpty.every((required) => required.includes(property)),
  );
}

export function toolPropertySchema(
  tool: OpenAiToolSpec | undefined,
  property: string,
): unknown {
  return toolParameterSchema(tool).propertySchemas[property];
}

export function stringEnumValues(
  tool: OpenAiToolSpec | undefined,
  property: string,
): string[] {
  const propertySchema = toolPropertySchema(tool, property);
  if (!isRecord(propertySchema)) return [];
  return unionStringArrays(
    propertySchema.enum,
    propertySchema.const === undefined ? undefined : [propertySchema.const],
  );
}

export function toolArgumentsSatisfySchema(
  args: Record<string, unknown>,
  tool: OpenAiToolSpec,
): boolean {
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return true;
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  for (const required of schema.required) {
    const property =
      firstMatchingProperty([required], schema.properties, normalizedProperties) ??
      required;
    if (
      !argumentValueSatisfiesSchema(
        args[property],
        schema.propertySchemas[property],
        true,
      )
    )
      return false;
  }
  for (const [property, value] of Object.entries(args)) {
    const propertyName = firstMatchingProperty(
      [property],
      schema.properties,
      normalizedProperties,
    );
    if (!propertyName) continue;
    if (
      !argumentValueSatisfiesSchema(value, schema.propertySchemas[propertyName], false)
    )
      return false;
  }
  return true;
}

export function argumentValueSatisfiesSchema(
  value: unknown,
  schema: unknown,
  required: boolean,
): boolean {
  if (value === undefined) return !required;
  const record = isRecord(schema) ? schema : undefined;
  if (value === null) return Boolean(record && schemaAllowsJsonType(record, "null"));
  if (!record) return true;
  const constValue = record.const;
  if (constValue !== undefined && value !== constValue) return false;
  if (Array.isArray(record.enum) && !record.enum.some((item) => item === value))
    return false;
  const anyOf = composedToolSchemas(record.anyOf);
  if (
    anyOf.length &&
    !anyOf.some((item) => argumentValueSatisfiesSchema(value, item, true))
  )
    return false;
  const oneOf = composedToolSchemas(record.oneOf);
  if (
    oneOf.length &&
    !oneOf.some((item) => argumentValueSatisfiesSchema(value, item, true))
  )
    return false;
  const allOf = composedToolSchemas(record.allOf);
  if (
    allOf.length &&
    !allOf.every((item) => argumentValueSatisfiesSchema(value, item, true))
  )
    return false;
  const types = schemaJsonTypes(record);
  if (types.length && !types.some((type) => jsonValueMatchesType(value, type)))
    return false;
  if (
    objectConstraintsApply(record, value, types) &&
    !objectValueSatisfiesSchema(value, record)
  )
    return false;
  if (
    arrayConstraintsApply(record, value, types) &&
    !arrayValueSatisfiesSchema(value, record)
  )
    return false;
  return true;
}

export function objectConstraintsApply(
  schema: Record<string, unknown>,
  value: unknown,
  types: string[],
): boolean {
  if (
    !isRecord(schema.properties) &&
    !Array.isArray(schema.required) &&
    schema.additionalProperties === undefined
  )
    return false;
  if (jsonValueMatchesType(value, "object")) return true;
  return !types.length || types.includes("object");
}

export function objectValueSatisfiesSchema(
  value: unknown,
  schema: Record<string, unknown>,
): boolean {
  if (!jsonValueMatchesType(value, "object")) return false;
  const recordValue = value as Record<string, unknown>;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const propertyNames = Object.keys(properties);
  const normalizedProperties = new Map(
    propertyNames.map((property) => [normalizeToolName(property), property]),
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const requiredProperty of required) {
    const property =
      firstMatchingProperty([requiredProperty], propertyNames, normalizedProperties) ??
      requiredProperty;
    if (
      !argumentValueSatisfiesSchema(recordValue[property], properties[property], true)
    )
      return false;
  }
  for (const [property, nestedValue] of Object.entries(recordValue)) {
    const propertyName = firstMatchingProperty(
      [property],
      propertyNames,
      normalizedProperties,
    );
    if (propertyName) {
      if (!argumentValueSatisfiesSchema(nestedValue, properties[propertyName], false))
        return false;
      continue;
    }
    if (schema.additionalProperties === false) return false;
    if (
      isRecord(schema.additionalProperties) &&
      !argumentValueSatisfiesSchema(nestedValue, schema.additionalProperties, false)
    )
      return false;
  }
  return true;
}

export function arrayConstraintsApply(
  schema: Record<string, unknown>,
  value: unknown,
  types: string[],
): boolean {
  if (
    schema.items === undefined &&
    !Array.isArray(schema.prefixItems) &&
    schema.minItems === undefined &&
    schema.maxItems === undefined
  )
    return false;
  if (Array.isArray(value)) return true;
  return !types.length || types.includes("array");
}

export function arrayValueSatisfiesSchema(
  value: unknown,
  schema: Record<string, unknown>,
): boolean {
  if (!Array.isArray(value)) return false;
  const minItems =
    typeof schema.minItems === "number" && Number.isFinite(schema.minItems)
      ? schema.minItems
      : undefined;
  const maxItems =
    typeof schema.maxItems === "number" && Number.isFinite(schema.maxItems)
      ? schema.maxItems
      : undefined;
  if (minItems !== undefined && value.length < minItems) return false;
  if (maxItems !== undefined && value.length > maxItems) return false;
  const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
  for (let index = 0; index < prefixItems.length && index < value.length; index += 1) {
    if (!argumentValueSatisfiesSchema(value[index], prefixItems[index], true))
      return false;
  }
  if (schema.items === false && value.length > prefixItems.length) return false;
  if (isRecord(schema.items)) {
    for (let index = prefixItems.length; index < value.length; index += 1) {
      if (!argumentValueSatisfiesSchema(value[index], schema.items, true)) return false;
    }
  }
  return true;
}

export function schemaJsonTypes(schema: Record<string, unknown>): string[] {
  if (typeof schema.type === "string") return [schema.type];
  return Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === "string")
    : [];
}

export function schemaAllowsJsonType(
  schema: Record<string, unknown>,
  type: string,
): boolean {
  const types = schemaJsonTypes(schema);
  return !types.length || types.includes(type);
}

export function jsonValueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value) && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}
