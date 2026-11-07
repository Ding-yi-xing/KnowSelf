import { describe, it, expect } from "vitest";
import { createSemaphore } from "../dist/concurrency.js";

describe("createSemaphore", () => {
  it("acquires up to max concurrently", async () => {
    const sem = createSemaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(r1).toBeTypeOf("function");
    expect(r2).toBeTypeOf("function");

    r1();
    r2();
  });

  it("queues beyond max", async () => {
    const sem = createSemaphore(1);
    const order: string[] = [];

    const r1 = await sem.acquire();
    order.push("first");

    const p2 = sem.acquire().then((r) => {
      order.push("second");
      r();
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["first"]);

    r1();
    await p2;
    expect(order).toEqual(["first", "second"]);
  });

  it("rejects on abort signal", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sem.acquire(ctrl.signal)).rejects.toThrow("ABORTED");
  });
});
