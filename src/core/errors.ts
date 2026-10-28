export class AppError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 501 | 503,
    message: string,
    public readonly reason = 'REQUEST_FAILED',
  ) {
    super(message);
    this.name = 'AppError';
  }
}
