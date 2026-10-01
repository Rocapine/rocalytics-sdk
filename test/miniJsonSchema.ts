// A deliberately small JSON Schema (draft 2020-12) validator, for test use only.
//
// Why not a full validator: the contract schema uses a small, fixed set of
// keywords, and the package keeps its tooling short. Why this is still honest:
// `unsupportedKeywords` walks a schema and names every keyword this file does not
// enforce, so a test can refuse a schema that leans on one instead of passing it
// vacuously.

export type SchemaError = { path: string; keyword: string; message: string };

type Schema = Record<string, unknown>;

const ANNOTATIONS = ["$schema", "$id", "$comment", "title", "description", "examples", "default"];
const ENFORCED = [
  "$defs", "$ref",
  "type", "const", "enum",
  "minLength", "maxLength", "pattern",
  "minimum", "maximum",
  "properties", "required", "additionalProperties", "propertyNames", "minProperties", "maxProperties",
  "items", "minItems", "maxItems", "uniqueItems",
  "oneOf", "anyOf", "allOf", "if", "then", "else",
];
const KNOWN = new Set([...ANNOTATIONS, ...ENFORCED]);

// Keywords whose value is a map of NAME -> subschema, so the names are not keywords.
const SCHEMA_MAPS = new Set(["properties", "$defs"]);
const SCHEMA_LISTS = new Set(["oneOf", "anyOf", "allOf"]);
const SCHEMA_SINGLE = new Set(["items", "additionalProperties", "propertyNames", "if", "then", "else"]);

export function unsupportedKeywords(schema: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (!KNOWN.has(key)) found.add(key);
      if (SCHEMA_MAPS.has(key) && value && typeof value === "object") {
        Object.values(value).forEach(walk);
      } else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) {
        value.forEach(walk);
      } else if (SCHEMA_SINGLE.has(key)) {
        walk(value);
      }
    }
  };
  walk(schema);
  return [...found].sort();
}

const typeOf = (v: unknown): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
};

const matchesType = (v: unknown, t: string): boolean => {
  const actual = typeOf(v);
  if (t === "number") return (actual === "number" || actual === "integer") && Number.isFinite(v as number);
  return actual === t;
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length &&
      ka.every((k) => deepEqual((a as Schema)[k], (b as Schema)[k]));
  }
  return false;
};

const pointer = (base: string, token: string | number) =>
  `${base}/${String(token).replace(/~/g, "~0").replace(/\//g, "~1")}`;

export function validate(root: object, value: unknown): SchemaError[] {
  const resolve = (ref: string): Schema => {
    if (!ref.startsWith("#/")) throw new Error(`miniJsonSchema: only local refs are supported, got ${ref}`);
    let node: unknown = root;
    for (const raw of ref.slice(2).split("/")) {
      const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      node = (node as Schema)?.[token];
    }
    if (!node || typeof node !== "object") throw new Error(`miniJsonSchema: unresolved ref ${ref}`);
    return node as Schema;
  };

  const check = (schema: Schema, v: unknown, path: string): SchemaError[] => {
    const errors: SchemaError[] = [];
    const fail = (keyword: string, message: string, at = path) => errors.push({ path: at, keyword, message });

    if (typeof schema.$ref === "string") errors.push(...check(resolve(schema.$ref), v, path));

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
      if (!types.some((t) => matchesType(v, t))) fail("type", `expected ${types.join("|")}, got ${typeOf(v)}`);
    }
    if ("const" in schema && !deepEqual(v, schema.const)) fail("const", `expected ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(v, e))) {
      fail("enum", `expected one of ${JSON.stringify(schema.enum)}`);
    }

    if (typeof v === "string") {
      const length = [...v].length;
      if (typeof schema.minLength === "number" && length < schema.minLength) fail("minLength", `shorter than ${schema.minLength}`);
      if (typeof schema.maxLength === "number" && length > schema.maxLength) fail("maxLength", `longer than ${schema.maxLength}`);
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(v)) {
        fail("pattern", `does not match ${schema.pattern}`);
      }
    }

    if (typeof v === "number") {
      if (typeof schema.minimum === "number" && v < schema.minimum) fail("minimum", `below ${schema.minimum}`);
      if (typeof schema.maximum === "number" && v > schema.maximum) fail("maximum", `above ${schema.maximum}`);
    }

    if (typeOf(v) === "object") {
      const obj = v as Schema;
      const keys = Object.keys(obj);
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const name of (schema.required ?? []) as string[]) {
        if (!(name in obj)) fail("required", `missing "${name}"`);
      }
      for (const key of keys) {
        const at = pointer(path, key);
        if (key in props) {
          errors.push(...check(props[key], obj[key], at));
        } else if (schema.additionalProperties === false) {
          fail("additionalProperties", `unexpected property "${key}"`, at);
        } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          errors.push(...check(schema.additionalProperties as Schema, obj[key], at));
        }
        if (schema.propertyNames && typeof schema.propertyNames === "object") {
          errors.push(...check(schema.propertyNames as Schema, key, at));
        }
      }
      if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
        fail("minProperties", `fewer than ${schema.minProperties} properties`);
      }
      if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
        fail("maxProperties", `more than ${schema.maxProperties} properties`);
      }
    }

    if (Array.isArray(v)) {
      if (schema.items && typeof schema.items === "object") {
        v.forEach((item, i) => errors.push(...check(schema.items as Schema, item, pointer(path, i))));
      }
      if (typeof schema.minItems === "number" && v.length < schema.minItems) fail("minItems", `fewer than ${schema.minItems} items`);
      if (typeof schema.maxItems === "number" && v.length > schema.maxItems) fail("maxItems", `more than ${schema.maxItems} items`);
      if (schema.uniqueItems === true && v.some((x, i) => v.findIndex((y) => deepEqual(x, y)) !== i)) {
        fail("uniqueItems", "duplicate items");
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const sub of schema.allOf as Schema[]) errors.push(...check(sub, v, path));
    }
    if (Array.isArray(schema.anyOf) && !(schema.anyOf as Schema[]).some((sub) => check(sub, v, path).length === 0)) {
      fail("anyOf", "matches none of the alternatives");
    }
    if (Array.isArray(schema.oneOf)) {
      const matches = (schema.oneOf as Schema[]).filter((sub) => check(sub, v, path).length === 0).length;
      if (matches !== 1) fail("oneOf", `matches ${matches} alternatives, expected exactly 1`);
    }
    if (schema.if && typeof schema.if === "object") {
      const branch = check(schema.if as Schema, v, path).length === 0 ? schema.then : schema.else;
      if (branch && typeof branch === "object") errors.push(...check(branch as Schema, v, path));
    }

    return errors;
  };

  return check(root as Schema, value, "");
}
