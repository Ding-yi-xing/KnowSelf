/**
 * W2/T02 —— schema-bridge 降维到 dsh 强制子集的六条回归用例（D1/P0）。
 *
 * S1 简单对象有 properties.key；S2 判别联合 oneOf.length===2 且无 anyOf/$ref/definitions；
 * S3 交叉类型合并 properties；S4 string|number → oneOf.length===2；
 * S5 重叠 object 联合**无 oneOf**；S6 递归遍历产物、关键字只允许白名单。
 * S7（加强）用真实 dsh `assertSupportedJsonSchema` 校验全部 16 个工具 parameters
 * 与手写 INGEST_PARAMETERS —— 这是 05 §3 T02 要求的实测证据。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { zodToJsonSchema } from "../src/schema-bridge.js";
import { INGEST_PARAMETERS } from "../src/tools/ingest-schema.js";
import { makeTools } from "../src/tools.js";
import type { KnowselfServices } from "../src/services.js";

/** dsh `JsonSchemaNode` 强制子集白名单（与 schema-bridge.ts 一致）。 */
const ALLOWED_KEYS = new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
]);

/**
 * 递归收集产物里出现的所有**关键字**。
 * `properties` 的值是「属性名 → 子 schema」映射，属性名不是关键字，
 * 因此只递归子 schema、不把属性名计入（否则 S6 会误判 `key` 等字段名）。
 */
function collectKeys(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, found);
    return found;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      found.push(key);
      if (
        key === "properties" &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        for (const sub of Object.values(value as Record<string, unknown>)) {
          collectKeys(sub, found);
        }
      } else {
        collectKeys(value, found);
      }
    }
  }
  return found;
}

/** 把产物当作普通对象读取（测试侧视图，避免类型体操）。 */
function asNode(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("T02 / S1~S6：zodToJsonSchema 宽松优先降维", () => {
  it("S1 简单对象：properties.key.type === 'string' 且 required 含 key", () => {
    const node = asNode(zodToJsonSchema(z.object({ key: z.string() })));
    expect(node.type).toBe("object");
    expect(asNode(asNode(node.properties).key).type).toBe("string");
    expect(node.required).toContain("key");
    expect(() => assertSupportedJsonSchema(node)).not.toThrow();
  });

  it("S2 判别联合：oneOf.length === 2 且无 anyOf / $ref / definitions", () => {
    const node = asNode(
      zodToJsonSchema(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), a: z.string() }),
          z.object({ kind: z.literal("b"), b: z.string() }),
        ]),
      ),
    );
    expect(Array.isArray(node.oneOf)).toBe(true);
    expect((node.oneOf as unknown[]).length).toBe(2);
    const text = JSON.stringify(node);
    for (const forbidden of ["anyOf", "$ref", "definitions", "$defs", "allOf"]) {
      expect(text).not.toContain(`"${forbidden}"`);
    }
    // 判别键的 const 必须带 type，否则 dsh 校验器会拒
    const first = asNode((node.oneOf as unknown[])[0]);
    expect(asNode(asNode(first.properties).kind)).toEqual({
      type: "string",
      const: "a",
    });
    expect(() => assertSupportedJsonSchema(node)).not.toThrow();
  });

  it("S3 A.and(B) 交叉：properties 同时含 A、B 的键", () => {
    const node = asNode(
      zodToJsonSchema(z.object({ a: z.string() }).and(z.object({ b: z.number() }))),
    );
    const properties = asNode(node.properties);
    expect(Object.keys(properties)).toContain("a");
    expect(Object.keys(properties)).toContain("b");
    expect(node.required).toContain("a");
    expect(node.required).toContain("b");
    expect(() => assertSupportedJsonSchema(node)).not.toThrow();
  });

  it("S4 string|number 原始联合 → oneOf.length === 2", () => {
    const node = asNode(zodToJsonSchema(z.union([z.string(), z.number()])));
    expect(Array.isArray(node.oneOf)).toBe(true);
    expect((node.oneOf as unknown[]).length).toBe(2);
    expect(node.type).toBeUndefined(); // 不能与 oneOf 并存
    expect(() => assertSupportedJsonSchema(node)).not.toThrow();
  });

  it("S5 可能重叠的 object 联合：不生成 oneOf，降为宽松 object", () => {
    const node = asNode(
      zodToJsonSchema(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })])),
    );
    expect(node.oneOf).toBeUndefined();
    expect(node.type).toBe("object");
    expect(node.additionalProperties).toBe(true);
    expect(Object.keys(asNode(node.properties))).toEqual(
      expect.arrayContaining(["a", "b"]),
    );
    expect(() => assertSupportedJsonSchema(node)).not.toThrow();
  });

  it("S6 递归遍历产物：关键字只允许白名单，且无任何 $ 前缀键", () => {
    const samples = [
      zodToJsonSchema(z.object({ key: z.string(), n: z.number().int().optional() })),
      zodToJsonSchema(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), a: z.string() }),
          z.object({ kind: z.literal("b"), b: z.string() }),
        ]),
      ),
      zodToJsonSchema(z.object({ a: z.string() }).and(z.object({ b: z.number() }))),
      zodToJsonSchema(z.union([z.string(), z.number()])),
      zodToJsonSchema(
        z.object({
          nullable: z.string().nullable().optional(),
          tags: z.array(z.string()).optional(),
          mode: z.enum(["x", "y"]).optional(),
        }),
      ),
      INGEST_PARAMETERS,
    ];
    for (const sample of samples) {
      const keys = collectKeys(sample);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(ALLOWED_KEYS.has(key), `不允许的关键字：${key}`).toBe(true);
        expect(key.startsWith("$")).toBe(false);
      }
      expect(() => assertSupportedJsonSchema(sample)).not.toThrow();
    }
  });
});

describe("T02 / S7：真实 dsh 校验器全量实测（16 工具 + INGEST_PARAMETERS）", () => {
  it("INGEST_PARAMETERS 通过 assertSupportedJsonSchema，且 oneOf.length === 3", () => {
    expect(() => assertSupportedJsonSchema(INGEST_PARAMETERS)).not.toThrow();
    expect(INGEST_PARAMETERS.oneOf).toHaveLength(3);
    const kinds = (INGEST_PARAMETERS.oneOf ?? []).map(
      (branch) => branch.properties?.kind?.const,
    );
    expect(kinds).toEqual(["file", "url", "paste"]);
    console.log(
      `[w2-evidence] assertSupportedJsonSchema(INGEST_PARAMETERS) = PASS; ` +
        `oneOf.length = ${INGEST_PARAMETERS.oneOf?.length}; kinds = ${JSON.stringify(kinds)}`,
    );
  });

  it("16 个工具 parameters 全量通过 assertSupportedJsonSchema 且均非空", () => {
    // makeTools 只构造 ToolDefinition，run 闭包不会执行，传空桩即可。
    const tools = makeTools({} as KnowselfServices);
    expect(tools).toHaveLength(16);
    for (const tool of tools) {
      const keys = Object.keys(tool.parameters as Record<string, unknown>);
      expect(keys.length, `${tool.name} parameters 不应为空`).toBeGreaterThan(0);
      expect(
        () => assertSupportedJsonSchema(tool.parameters),
        `${tool.name} 未通过 dsh 校验`,
      ).not.toThrow();
    }
  });
});
