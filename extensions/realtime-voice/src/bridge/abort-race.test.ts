import { describe, expect, it, vi } from "vitest";
import { raceWithAbort } from "./abort-race.js";

describe("raceWithAbort", () => {
  it("removes the abort listener when work completes normally", async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );

    await expect(
      raceWithAbort(
        controller.signal,
        Promise.resolve("done"),
        () => "aborted",
      ),
    ).resolves.toBe("done");

    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  it("returns the abort result when the signal aborts first", async () => {
    const controller = new AbortController();
    const work = new Promise<string>(() => {});
    const result = raceWithAbort(controller.signal, work, () => "aborted");

    controller.abort();

    await expect(result).resolves.toBe("aborted");
  });
});
