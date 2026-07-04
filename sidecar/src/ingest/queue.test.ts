// Tests for the bounded FIFO worker queue (`createQueue`).
//
// Covers the concurrency cap via a simultaneous-active high-water mark, FIFO
// ordering under concurrency 1, error isolation (a rejecting task reaches
// `onError` exactly once and never poisons the queue), `clear()` dropping
// pending work while in-flight tasks finish, and `size()` accounting.

import { describe, expect, test } from "bun:test";
import { createQueue } from "./queue.ts";

/** Promise-based delay so tasks are genuinely async. */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("createQueue", () => {
  test("never exceeds the concurrency cap (and saturates it)", async () => {
    const concurrency = 3;
    const q = createQueue({ concurrency });

    let active = 0;
    let highWater = 0;
    const track = async (): Promise<void> => {
      active += 1;
      highWater = Math.max(highWater, active);
      await delay(20);
      active -= 1;
    };

    for (let i = 0; i < 10; i++) q.enqueue(track);

    // Drain: poll until the queue reports empty, then let the final batch
    // settle.
    while (q.size() > 0) await delay(5);
    await delay(20);

    // Hard contract: never exceed the cap. With 10 tasks and cap 3, the
    // synchronous pump saturates immediately, so we also expect to hit it.
    expect(highWater).toBeLessThanOrEqual(concurrency);
    expect(highWater).toBe(concurrency);
  });

  test("FIFO completion order under concurrency 1", async () => {
    const q = createQueue({ concurrency: 1 });
    const done: number[] = [];

    for (let i = 0; i < 5; i++) {
      q.enqueue(async () => {
        done.push(i);
        await delay(5);
      });
    }

    while (q.size() > 0) await delay(2);
    expect(done).toEqual([0, 1, 2, 3, 4]);
  });

  test("a rejecting task is isolated: onError fires once, next task still runs", async () => {
    const errors: unknown[] = [];
    const q = createQueue({
      concurrency: 1,
      onError: (e) => errors.push(e),
    });

    const ran: string[] = [];
    q.enqueue(async () => {
      throw new Error("boom");
    });
    q.enqueue(async () => {
      ran.push("second-ran");
    });

    while (q.size() > 0) await delay(2);
    await delay(5);

    expect(ran).toEqual(["second-ran"]); // queue survived the rejection
    expect(errors).toHaveLength(1); // forwarded exactly once
    expect((errors[0] as Error).message).toBe("boom");
  });

  test("clear() drops pending tasks; in-flight task runs to completion", async () => {
    const q = createQueue({ concurrency: 1 });
    const ran: string[] = [];

    // First task is slow → in-flight when we clear.
    q.enqueue(async () => {
      await delay(20);
      ran.push("first");
    });
    // These two stay pending (concurrency 1).
    q.enqueue(async () => {
      ran.push("second");
    });
    q.enqueue(async () => {
      ran.push("third");
    });

    expect(q.size()).toBe(3); // 1 active + 2 pending
    q.clear();
    expect(q.size()).toBe(1); // only the in-flight task remains

    while (q.size() > 0) await delay(5);
    await delay(5);

    expect(ran).toEqual(["first"]); // dropped tasks never ran
  });

  test("size() reflects pending + active", async () => {
    const q = createQueue({ concurrency: 2 });
    expect(q.size()).toBe(0);

    q.enqueue(async () => {
      await delay(10);
    });
    q.enqueue(async () => {
      await delay(10);
    });
    q.enqueue(async () => {
      await delay(10);
    });

    // 3 enqueued, cap 2 → 2 active + 1 pending.
    expect(q.size()).toBe(3);

    while (q.size() > 0) await delay(5);
    expect(q.size()).toBe(0);
  });
});
