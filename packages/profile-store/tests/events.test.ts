import { describe, it, expect } from "vitest";
import { createEventBus } from "../src/events";
import type { ProfileChangeEvent } from "@knowself/contracts";

function makeEvent(overrides: Partial<ProfileChangeEvent> = {}): ProfileChangeEvent {
  return {
    kind: "update",
    ref_kind: "core",
    ref_id: "core_main",
    occurred_at: "2026-01-01T00:00:00.000Z",
    provenance: "user",
    ...overrides,
  };
}

describe("createEventBus", () => {
  it("空总线 emit 不抛错", () => {
    const bus = createEventBus();
    expect(() => bus.emit(makeEvent())).not.toThrow();
  });

  it("单订阅者收到事件且参数原样传入", () => {
    const bus = createEventBus();
    const received: ProfileChangeEvent[] = [];
    bus.on((e) => {
      received.push(e);
    });
    const ev = makeEvent({ ref_id: "test-1" });
    bus.emit(ev);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(ev);
  });

  it("多订阅者按注册顺序依次收到事件", () => {
    const bus = createEventBus();
    const order: number[] = [];
    bus.on(() => {
      order.push(1);
    });
    bus.on(() => {
      order.push(2);
    });
    bus.on(() => {
      order.push(3);
    });
    bus.emit(makeEvent());
    expect(order).toEqual([1, 2, 3]);
  });

  it("订阅者抛错时不影响后续订阅者收到事件", () => {
    const bus = createEventBus();
    const received: string[] = [];
    bus.on(() => {
      throw new Error("boom");
    });
    bus.on(() => {
      received.push("second");
    });
    bus.on(() => {
      received.push("third");
    });
    expect(() => bus.emit(makeEvent())).not.toThrow();
    expect(received).toEqual(["second", "third"]);
  });

  it("unsubscribe 后该订阅者不再收到事件，但其他订阅者仍收到", () => {
    const bus = createEventBus();
    const received: string[] = [];
    const unsub1 = bus.on(() => {
      received.push("A");
    });
    bus.on(() => {
      received.push("B");
    });
    unsub1();
    bus.emit(makeEvent());
    expect(received).toEqual(["B"]);
  });
});
