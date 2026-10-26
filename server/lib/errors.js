/** An error raised while processing an article. `retryable` marks transient failures only. */
export class PipelineError extends Error {
  constructor(code, message, options = {}) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "PipelineError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

/** An error that maps directly onto an HTTP response for API clients. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export function toPipelineError(err) {
  if (err instanceof PipelineError) return err;
  if (err instanceof Error)
    return new PipelineError("INTERNAL", err.message || "Unexpected error", {
      cause: err,
    });
  return new PipelineError("INTERNAL", "Unexpected error");
}

export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
