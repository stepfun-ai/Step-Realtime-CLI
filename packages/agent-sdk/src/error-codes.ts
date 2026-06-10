export const ERR_SESSION_NOT_FOUND = "ERR_SESSION_NOT_FOUND";
export const ERR_SESSION_CORRUPT = "ERR_SESSION_CORRUPT";
export const ERR_SESSION_BUSY = "ERR_SESSION_BUSY";

export const ERR_TOOL_NOT_SUPPORTED = "TOOL_NOT_SUPPORTED";

export class SdkSessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SdkSessionError";
    this.code = code;
  }
}
