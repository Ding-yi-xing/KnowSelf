import { describe, it, expect } from "vitest";
import { createAbortRegistry } from "../src/lib/abort";

describe("createAbortRegistry", () => {
  it("register 返回的 AbortSignal 在 abort 调用前未触发", () => {
    const registry = createAbortRegistry();
    const signal = registry.register("conv-1");
    expect(signal.aborted).toBe(false);
  });

  it("abort 调用后对应 signal 触发 aborted=true", () => {
    const registry = createAbortRegistry();
    const signal = registry.register("conv-1");
    registry.abort("conv-1");
    expect(signal.aborted).toBe(true);
  });

  it("abort 不存在的 conversationId 返回 false", () => {
    const registry = createAbortRegistry();
    expect(registry.abort("nonexistent")).toBe(false);
  });

  it("abort 存在的 conversationId 返回 true", () => {
    const registry = createAbortRegistry();
    registry.register("conv-2");
    expect(registry.abort("conv-2")).toBe(true);
  });

  it("同一 conversationId 重复 register 自动 abort 上一次的 signal", () => {
    const registry = createAbortRegistry();
    const s1 = registry.register("conv-3");
    const s2 = registry.register("conv-3");
    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(false);
  });
});
