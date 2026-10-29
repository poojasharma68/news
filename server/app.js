import path from "node:path";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { createNewsRouter } from "./routes/news.routes.js";
import { createPublicRouter } from "./routes/public.routes.js";

export function createApp({ config, service, auth, publicConfig }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  const supabaseOrigin = config.supabase.url
    ? new URL(config.supabase.url).origin
    : null;
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: [
            "'self'",
            "data:",
            "blob:",
            "https:",
            ...(config.isProduction ? [] : ["http:"]),
          ],
          connectSrc: ["'self'", ...(supabaseOrigin ? [supabaseOrigin] : [])],
          frameSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );

  // The website's read-only API: open to every origin and mounted before sign-in is required.
  app.use("/api/public", createPublicRouter(service), notFoundHandler);

  if (config.corsOrigins.length) {
    app.use(
      "/api",
      cors({ origin: config.corsOrigins, credentials: false, maxAge: 600 }),
    );
  }

  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/config", (_req, res) => {
    res.json(publicConfig);
  });

  app.use(
    "/api",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 1500,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: { message: "Too many requests. Please slow down." } },
    }),
  );
  app.use(
    "/api",
    auth,
    createNewsRouter(service, { maxImageBytes: config.fetch.maxImageBytes }),
  );
  app.use("/api", notFoundHandler);

  // Processed images are kept here until an editor converts them to the CDN, so this is
  // served with every provider.
  app.use(
    "/dev-cdn",
    (_req, res, next) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      next();
    },
    express.static(path.resolve(config.cdn.localDir), {
      immutable: true,
      maxAge: "30d",
      index: false,
      dotfiles: "deny",
    }),
  );

  if (config.serveClient) {
    const clientDir = path.resolve("dist");
    app.use(express.static(clientDir, { index: false, maxAge: "1h" }));
    app.get("*", (_req, res) =>
      res.sendFile(path.join(clientDir, "index.html")),
    );
  }

  app.use(errorHandler);
  return app;
}
