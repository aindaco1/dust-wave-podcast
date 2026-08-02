export class PublicFeedValidationError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PublicFeedValidationError";
    this.code = code;
  }
}
