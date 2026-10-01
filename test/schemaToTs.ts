// A small JSON Schema -> TypeScript type generator, for the drift test only.
//
// It understands exactly the keywords the contract schema uses and throws on any
// other, so a schema change that leans on a new keyword fails loudly instead of
// generating a type that silently ignores it. Value constraints (patterns,
// lengths, counts) have no TypeScript form and are deliberately skipped.

type Schema = Record<string, unknown>;

// No type-level meaning: annotations, and value constraints the type system cannot express.
const SKIPPED = new Set([
  "$schema", "$id", "$comment", "$defs", "title", "description", "examples", "default",
  "pattern", "minLength", "maxLength", "minimum", "maximum",
  "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "propertyNames",
]);
const HANDLED = new Set([
  "$ref", "const", "enum", "anyOf", "oneOf", "type", "items", "properties", "required",
  "additionalProperties", "allOf",
]);

const PRIMITIVE: Record<string, string> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
  null: "null",
};

type Prop = { type: string; optional: boolean };

export function schemaToTs(root: Schema): string {
  const resolve = (ref: string): Schema => {
    if (!ref.startsWith("#/")) throw new Error(`schemaToTs: only local refs, got ${ref}`);
    let node: unknown = root;
    for (const token of ref.slice(2).split("/")) node = (node as Schema)[token];
    if (!node || typeof node !== "object") throw new Error(`schemaToTs: unresolved ref ${ref}`);
    return node as Schema;
  };

  const indent = (text: string, by: string) => text.split("\n").join(`\n${by}`);
  const union = (parts: string[]) => {
    const unique = [...new Set(parts)];
    return unique.length === 1 ? unique[0] : unique.map((p) => (p.includes("\n") ? `(${p})` : p)).join(" | ");
  };
  const objectText = (props: [string, Prop][], depth: string) =>
    props.length === 0
      ? "{}"
      : `{\n${props.map(([k, p]) => `${depth}  ${k}${p.optional ? "?" : ""}: ${indent(p.type, `${depth}  `)};`).join("\n")}\n${depth}}`;

  const propsOf = (node: Schema): [string, Prop][] => {
    const required = new Set((node.required ?? []) as string[]);
    const props = (node.properties ?? {}) as Record<string, Schema>;
    return Object.entries(props).map(([k, s]) => [k, { type: gen(s), optional: !required.has(k) }]);
  };

  const checkKeywords = (node: Schema) => {
    for (const k of Object.keys(node)) {
      if (!SKIPPED.has(k) && !HANDLED.has(k)) throw new Error(`schemaToTs: unsupported keyword "${k}"`);
    }
  };

  const genObject = (node: Schema): string => {
    const hasProps = node.properties !== undefined;
    const extra = node.additionalProperties;
    if (hasProps) {
      if (extra !== false) throw new Error("schemaToTs: an object with properties must set additionalProperties: false");
      return objectText(propsOf(node), "");
    }
    if (extra && typeof extra === "object") return `{\n  [key: string]: ${gen(extra as Schema)};\n}`;
    throw new Error("schemaToTs: an object needs properties or an additionalProperties schema");
  };

  // The one conditional the contract uses: allOf: [{ if: { properties: { P: { const: C } } }, then, else }].
  // It becomes a union of the object with P narrowed to C (plus `then`) and with P excluding C (plus `else`).
  const genConditionalObject = (node: Schema): string => {
    const all = node.allOf as Schema[];
    if (all.length !== 1) throw new Error("schemaToTs: allOf must hold exactly one if/then/else");
    const cond = all[0];
    for (const k of Object.keys(cond)) {
      if (!["if", "then", "else"].includes(k)) throw new Error(`schemaToTs: unsupported keyword "${k}" in allOf`);
    }
    const ifProps = ((cond.if as Schema).properties ?? {}) as Record<string, Schema>;
    const names = Object.keys(ifProps);
    if (names.length !== 1 || !("const" in ifProps[names[0]]) || Object.keys(ifProps[names[0]]).length !== 1) {
      throw new Error("schemaToTs: if must test one property against a const");
    }
    const [discriminant] = names;
    const constText = JSON.stringify(ifProps[discriminant].const);
    const base = propsOf({ ...node, allOf: undefined });
    const branch = (narrow: (t: string) => string, overlay: Schema | undefined) => {
      const overlayProps = ((overlay ?? {}).properties ?? {}) as Record<string, Schema>;
      for (const k of Object.keys(overlay ?? {})) {
        if (k !== "properties") throw new Error(`schemaToTs: unsupported keyword "${k}" in then/else`);
      }
      return objectText(
        base.map(([k, p]): [string, Prop] => {
          let type = k === discriminant ? narrow(p.type) : p.type;
          if (overlayProps[k]) type = `(${type}) & (${gen(overlayProps[k])})`;
          return [k, { ...p, type }];
        }),
        "",
      );
    };
    return union([
      branch((t) => `(${t}) & ${constText}`, cond.then as Schema | undefined),
      branch((t) => `Exclude<${t}, ${constText}>`, cond.else as Schema | undefined),
    ]);
  };

  function gen(node: Schema): string {
    checkKeywords(node);
    if (typeof node.$ref === "string") {
      const others = Object.keys(node).filter((k) => k !== "$ref" && !SKIPPED.has(k));
      if (others.length) throw new Error(`schemaToTs: $ref alongside ${others.join(", ")}`);
      return gen(resolve(node.$ref));
    }
    if ("const" in node) return JSON.stringify(node.const);
    if (Array.isArray(node.enum)) return union(node.enum.map((v) => JSON.stringify(v)));
    const alternatives = (node.anyOf ?? node.oneOf) as Schema[] | undefined;
    if (alternatives) return union(alternatives.map(gen));
    if (node.allOf) return genConditionalObject(node);

    const types = Array.isArray(node.type) ? (node.type as string[]) : node.type ? [node.type as string] : [];
    if (types.length === 0) throw new Error(`schemaToTs: a node with no type: ${JSON.stringify(node)}`);
    return union(
      types.map((t) => {
        if (t === "array") return `Array<${node.items ? gen(node.items as Schema) : "unknown"}>`;
        if (t === "object") return genObject(node);
        if (PRIMITIVE[t]) return PRIMITIVE[t];
        throw new Error(`schemaToTs: unsupported type "${t}"`);
      }),
    );
  }

  return gen(root);
}
