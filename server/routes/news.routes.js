import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { HttpError } from "../lib/errors.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import {
  batchSchema,
  cardUpdateSchema,
  exportSchema,
  idListSchema,
  idParamSchema,
  listQuerySchema,
  validateBody,
  validateParams,
  validateQuery,
} from "../middleware/validateUrl.js";
import {
  isAcceptedImageContentType,
  isAcceptedLogoContentType,
  LOGO_MAX_BYTES,
} from "../services/imageProcessor.js";

export function createNewsRouter(service, options) {
  const router = Router();
  const user = (locals) => locals.user?.email ?? null;

  const submitLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: {
        message: "Too many batches submitted. Please wait a few minutes.",
      },
    },
  });

  // Uploads stay in memory only until they are processed and sent to the CDN.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: options.maxImageBytes, files: 1, fields: 5 },
    fileFilter: (_req, file, cb) => {
      if (isAcceptedImageContentType(file.mimetype)) cb(null, true);
      else
        cb(new HttpError(415, "Upload a JPEG, PNG, WebP, GIF or AVIF image."));
    },
  });
  const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 5 },
    fileFilter: (_req, file, cb) => {
      if (isAcceptedLogoContentType(file.mimetype)) cb(null, true);
      else
        cb(new HttpError(415, "Upload an SVG, PNG, WebP, JPEG or GIF logo."));
    },
  });

  // ── Stats ──
  router.get(
    "/stats",
    asyncHandler(async (_req, res) => {
      res.json(await service.getStats());
    }),
  );

  // ── Batches ──
  router.post(
    "/batches",
    submitLimiter,
    validateBody(batchSchema),
    asyncHandler(async (_req, res) => {
      const result = await service.submitBatch(
        res.locals.body.urls,
        user(res.locals),
      );
      res.status(result.batch ? 201 : 200).json(result);
    }),
  );

  router.get(
    "/batches",
    asyncHandler(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
      res.json({ items: await service.listBatches(limit) });
    }),
  );

  router.get(
    "/batches/:id",
    validateParams(idParamSchema),
    asyncHandler(async (_req, res) => {
      res.json(await service.getBatch(res.locals.params.id));
    }),
  );

  router.post(
    "/batches/:id/retry",
    validateParams(idParamSchema),
    asyncHandler(async (_req, res) => {
      res.json(await service.retryBatch(res.locals.params.id));
    }),
  );

  router.post(
    "/batches/:id/cancel",
    validateParams(idParamSchema),
    asyncHandler(async (_req, res) => {
      res.json(await service.cancelBatch(res.locals.params.id));
    }),
  );

  // ── Cards: bulk actions ──
  router.post(
    "/cards/approve",
    validateBody(idListSchema),
    asyncHandler(async (_req, res) => {
      res.json(await service.approve(res.locals.body.ids, user(res.locals)));
    }),
  );

  router.post(
    "/cards/retry",
    validateBody(idListSchema),
    asyncHandler(async (_req, res) => {
      res.json(await service.retryCards(res.locals.body.ids, user(res.locals)));
    }),
  );

  // "Save final changes": the approved version becomes the one the public API serves.
  router.post(
    "/cards/publish",
    validateBody(idListSchema),
    asyncHandler(async (_req, res) => {
      res.json(
        await service.markPublished(res.locals.body.ids, user(res.locals)),
      );
    }),
  );

  router.post(
    "/cards/unpublish",
    validateBody(idListSchema),
    asyncHandler(async (_req, res) => {
      res.json(await service.unpublish(res.locals.body.ids, user(res.locals)));
    }),
  );

  router.post(
    "/cards/export",
    validateBody(exportSchema),
    asyncHandler(async (_req, res) => {
      const { ids, include_styles, format, variant } = res.locals.body;
      res.json(
        await service.exportHtml(ids, {
          includeStyles: include_styles,
          format,
          variant,
        }),
      );
    }),
  );

  // ── Cards: library ──
  router.get(
    "/cards",
    validateQuery(listQuerySchema),
    asyncHandler(async (_req, res) => {
      const q = res.locals.query;
      const result = await service.listCards({
        search: q.search,
        statuses: q.status,
        publishedFrom: q.from ? `${q.from}T00:00:00.000Z` : undefined,
        publishedTo: q.to ? `${q.to}T23:59:59.999Z` : undefined,
        batchId: q.batch_id,
        page: q.page,
        pageSize: q.page_size,
        sort: q.sort,
        ascending: q.order === "asc",
      });
      res.json({ ...result, page: q.page, page_size: q.page_size });
    }),
  );

  router.get(
    "/cards/:id",
    validateParams(idParamSchema),
    asyncHandler(async (_req, res) => {
      res.json(await service.getCard(res.locals.params.id));
    }),
  );

  router.get(
    "/cards/:id/outputs",
    validateParams(idParamSchema),
    asyncHandler(async (_req, res) => {
      res.json(await service.getOutputs(res.locals.params.id));
    }),
  );

  router.get(
    "/cards/:id/events",
    validateParams(idParamSchema),
    asyncHandler(async (_req, res) => {
      res.json({ items: await service.listEvents(res.locals.params.id) });
    }),
  );

  router.patch(
    "/cards/:id",
    validateParams(idParamSchema),
    validateBody(cardUpdateSchema),
    asyncHandler(async (_req, res) => {
      res.json(
        await service.updateCard(
          res.locals.params.id,
          res.locals.body,
          user(res.locals),
        ),
      );
    }),
  );

  router.delete(
    "/cards/:id",
    validateParams(idParamSchema),
    asyncHandler(async (_req, res) => {
      await service.deleteCard(res.locals.params.id);
      res.status(204).end();
    }),
  );

  router.post(
    "/cards/:id/retry",
    validateParams(idParamSchema),
    asyncHandler(async (_req, res) => {
      res.json(
        await service.retryCard(res.locals.params.id, user(res.locals)),
      );
    }),
  );

  router.post(
    "/cards/:id/cancel",
    validateParams(idParamSchema),
    asyncHandler(async (_req, res) => {
      res.json(await service.cancelCard(res.locals.params.id));
    }),
  );

  router.post(
    "/cards/:id/thumbnail",
    validateParams(idParamSchema),
    upload.single("thumbnail"),
    asyncHandler(async (req, res) => {
      if (!req.file)
        throw new HttpError(
          400,
          'Attach an image file in the "thumbnail" field.',
        );
      res.json(
        await service.uploadThumbnail(
          res.locals.params.id,
          req.file.buffer,
          user(res.locals),
        ),
      );
    }),
  );

  router.post(
    "/cards/:id/logo",
    validateParams(idParamSchema),
    logoUpload.single("logo"),
    asyncHandler(async (req, res) => {
      if (!req.file)
        throw new HttpError(400, 'Attach a logo file in the "logo" field.');
      res.json(
        await service.uploadLogo(
          res.locals.params.id,
          req.file.buffer,
          user(res.locals),
        ),
      );
    }),
  );

  return router;
}
