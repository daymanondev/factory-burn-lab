/** The only error type the core throws. `code` is stable so the plugin shell can map it to tool errors. */
export class FactoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FactoryError";
    this.code = code;
  }
}
