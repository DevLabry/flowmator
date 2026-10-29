export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}
