/** Error type for failed backend commands (mirrors the Rust `{ code, message }`). */
export class BridgeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}
