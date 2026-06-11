import { describe, it, expect } from "vitest";
import { AsyncFifo } from "./async-queue.js";

// ---------------------------------------------------------------------------
// async-queue.ts
// ---------------------------------------------------------------------------
describe("AsyncFifo", () => {
  it("buffers values pushed before pull", async () => {
    const fifo = new AsyncFifo<number>();
    fifo.push(1);
    fifo.push(2);
    fifo.push(3);
    expect(await fifo.next()).toBe(1);
    expect(await fifo.next()).toBe(2);
    expect(await fifo.next()).toBe(3);
  });

  it("parks a pull and resolves when a value is pushed", async () => {
    const fifo = new AsyncFifo<number>();
    const promise = fifo.next();
    fifo.push(42);
    expect(await promise).toBe(42);
  });

  it("resolves a waiting pull with null when close() is called", async () => {
    const fifo = new AsyncFifo<number>();
    const promise = fifo.next();
    fifo.close();
    expect(await promise).toBeNull();
  });

  it("returns null immediately from next() after close", async () => {
    const fifo = new AsyncFifo<number>();
    fifo.close();
    expect(await fifo.next()).toBeNull();
  });

  it("rejects a waiting pull when fail() is called", async () => {
    const fifo = new AsyncFifo<number>();
    const promise = fifo.next();
    const error = new Error("boom");
    fifo.fail(error);
    await expect(promise).rejects.toThrow("boom");
  });

  it("rejects next() immediately after fail()", async () => {
    const fifo = new AsyncFifo<number>();
    fifo.fail(new Error("fail-fast"));
    await expect(fifo.next()).rejects.toThrow("fail-fast");
  });

  it("push returns false after close", () => {
    const fifo = new AsyncFifo<number>();
    fifo.close();
    expect(fifo.push(1)).toBe(false);
  });

  it("push returns false after fail", () => {
    const fifo = new AsyncFifo<number>();
    fifo.fail(new Error("err"));
    expect(fifo.push(1)).toBe(false);
  });

  it("isOpen returns true initially, false after close", () => {
    const fifo = new AsyncFifo<number>();
    expect(fifo.isOpen()).toBe(true);
    fifo.close();
    expect(fifo.isOpen()).toBe(false);
  });

  it("isOpen returns false after fail", () => {
    const fifo = new AsyncFifo<number>();
    fifo.fail(new Error("x"));
    expect(fifo.isOpen()).toBe(false);
  });

  it("close() is idempotent", () => {
    const fifo = new AsyncFifo<number>();
    fifo.close();
    fifo.close(); // second call should be a no-op
    expect(fifo.isOpen()).toBe(false);
  });

  it("iterator protocol yields values then done on close", async () => {
    const fifo = new AsyncFifo<string>();
    fifo.push("a");
    fifo.push("b");
    fifo.close();

    const iter = fifo.iterator();
    const r1 = await iter.next();
    expect(r1).toEqual({ value: "a", done: false });
    const r2 = await iter.next();
    expect(r2).toEqual({ value: "b", done: false });
    const r3 = await iter.next();
    expect(r3).toEqual({ value: undefined, done: true });
  });

  it("iterator return() closes the fifo", async () => {
    const fifo = new AsyncFifo<number>();
    const iter = fifo.iterator();
    const result = await iter.return!();
    expect(result).toEqual({ value: undefined, done: true });
    expect(fifo.isOpen()).toBe(false);
  });

  it("drains buffer before parking on next()", async () => {
    const fifo = new AsyncFifo<number>();
    fifo.push(10);
    fifo.push(20);
    // First two should come from the buffer
    expect(await fifo.next()).toBe(10);
    expect(await fifo.next()).toBe(20);
    // Third should park, then resolve
    const p = fifo.next();
    fifo.push(30);
    expect(await p).toBe(30);
  });

  it("preserves FIFO ordering with interleaved push and pull", async () => {
    const fifo = new AsyncFifo<string>();
    const results: (string | null)[] = [];

    const p1 = fifo.next(); // parks
    fifo.push("first");
    results.push(await p1);

    fifo.push("second");
    results.push(await fifo.next());

    const p3 = fifo.next(); // parks
    fifo.push("third");
    results.push(await p3);

    expect(results).toEqual(["first", "second", "third"]);
  });
});
