// Simple FIFO async worker queue with bounded concurrency.
//
// The ingest orchestrator enqueues one task per source file. Concurrency is
// capped (default 3) so we don't fan out unbounded extraction/OCR. A task is
// any `() => Promise<void>`; rejections are forwarded to `onError` (which the
// orchestrator wires to the ingest log + an event) and NEVER crash the queue
// — the next task is always pumped.

export interface QueueHandle {
  /** Append a task to the FIFO and pump if capacity allows. */
  enqueue(task: () => Promise<void>): void;
  /** Drop all pending tasks (in-flight tasks run to completion). */
  clear(): void;
  /** Pending + active task count. */
  size(): number;
}

export interface QueueOptions {
  concurrency?: number;
  /** Invoked (sync) when a task rejects. Must not throw. */
  onError?: (err: unknown, task: () => Promise<void>) => void;
}

/**
 * Build a queue. `pump` re-enters itself on each completion so the scheduler
 * stays saturated up to `concurrency` until the FIFO drains.
 */
export function createQueue(opts: QueueOptions = {}): QueueHandle {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const tasks: Array<() => Promise<void>> = [];
  let active = 0;

  async function run(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (e) {
      // Never let a task error escape — forward to the handler, swallow else.
      try {
        opts.onError?.(e, task);
      } catch {
        /* handler must not throw; ignore */
      }
    } finally {
      active -= 1;
      pump();
    }
  }

  function pump(): void {
    while (active < concurrency && tasks.length > 0) {
      const next = tasks.shift()!;
      active += 1;
      // Fire and forget — `run` self-drains errors.
      void run(next);
    }
  }

  return {
    enqueue(task) {
      tasks.push(task);
      pump();
    },
    clear() {
      // Drop pending; in-flight tasks finish on their own.
      tasks.length = 0;
    },
    size() {
      return tasks.length + active;
    },
  };
}
