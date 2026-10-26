import { MulterError } from "multer";
import { HttpError, PipelineError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

/** Wraps async route handlers so rejected promises reach the error handler (Express 4). */
export function asyncHandler(fn) {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

const PIPELINE_STATUS = {
  INVALID_URL: 400,
  URL_NOT_ALLOWED: 400,
  IMAGE_INVALID: 422,
  IMAGE_UNSUPPORTED: 415,
  IMAGE_TOO_SMALL: 422,
  IMAGE_DOWNLOAD_FAILED: 422,
  TOO_LARGE: 413,
  DUPLICATE: 409,
  CDN_NOT_CONFIGURED: 503,
  CDN_UPLOAD_FAILED: 502,
  CDN_INVALID_RESPONSE: 502,
  DB_ERROR: 503,
};

export const notFoundHandler = (_req, _res, next) =>
  next(new HttpError(404, "Not found."));

export const errorHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res
      .status(err.status)
      .json({ error: { message: err.message, details: err.details } });
    return;
  }
  if (err instanceof PipelineError) {
    const status = PIPELINE_STATUS[err.code] ?? 500;
    if (status >= 500)
      logger.error("Request failed", {
        path: req.path,
        code: err.code,
        message: err.message,
      });
    res
      .status(status)
      .json({ error: { message: err.message, code: err.code } });
    return;
  }
  if (err instanceof MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res
      .status(status)
      .json({
        error: {
          message:
            err.code === "LIMIT_FILE_SIZE"
              ? "The image file is too large."
              : err.message,
        },
      });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: { message: "Request body is too large." } });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: { message: "Malformed JSON body." } });
    return;
  }
  // Unknown errors: log details server-side, return a generic message.
  logger.error("Unhandled error", {
    path: req.path,
    method: req.method,
    error: err,
  });
  res.status(500).json({ error: { message: "Internal server error." } });
};
