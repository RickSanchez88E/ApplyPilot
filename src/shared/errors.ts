export class AppError extends Error {
  readonly category: string;
  readonly retryable: boolean;

  constructor(message: string, category: string, retryable = false) {
    super(message);
    this.name = "AppError";
    this.category = category;
    this.retryable = retryable;
  }
}

export class ScrapingError extends AppError {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number, retryable = true) {
    super(message, "scraping", retryable);
    this.name = "ScrapingError";
    this.statusCode = statusCode;
  }
}

export class RateLimitError extends ScrapingError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Rate limited, retry after ${retryAfterMs}ms`, 429, true);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class SessionExpiredError extends ScrapingError {
  constructor() {
    super("LinkedIn session expired — refresh cookies", 403, false);
    this.name = "SessionExpiredError";
  }
}
