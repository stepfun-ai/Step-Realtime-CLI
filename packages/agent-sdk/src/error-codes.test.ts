import { describe, it, expect } from "vitest";
import {
  SdkSessionError,
  ERR_SESSION_NOT_FOUND,
  ERR_TOOL_NOT_SUPPORTED,
} from "./error-codes.js";

describe("SdkSessionError", () => {
  it("sets name, code, message correctly", () => {
    const err = new SdkSessionError(
      ERR_SESSION_NOT_FOUND,
      "session xyz not found",
    );
    expect(err.name).toBe("SdkSessionError");
    expect(err.code).toBe("ERR_SESSION_NOT_FOUND");
    expect(err.message).toBe("session xyz not found");
  });

  it("is an instance of Error", () => {
    const err = new SdkSessionError(ERR_TOOL_NOT_SUPPORTED, "nope");
    expect(err).toBeInstanceOf(Error);
  });
});
