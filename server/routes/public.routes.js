/**
 * Public, read-only API for the Masters' Union website. It serves only the version of each card
 * an editor saved with "Save final changes", needs no sign-in, and can be called from any origin.
 *
 *   GET /api/public/news?limit=12&offset=0   live cards, newest article first
 *   GET /api/public/news/:id                 one live card
 *   GET /api/public/news.css                 the card CSS (for the `html` of each card)
 *   GET /api/public/embed.js                 drop-in script that renders cards into a page
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { CARD_CSS } from "../../shared/newsCardStyles.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { idParamSchema, validateParams, validateQuery } from "../middleware/validateUrl.js";

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

/** Browsers and CDNs may keep a response this long; saved changes appear within a minute. */
const CACHE = "public, max-age=60, stale-while-revalidate=300";

export function createPublicRouter(service) {
  const router = Router();

  router.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: { message: "Too many requests. Please slow down." } },
    }),
  );
  router.use((_req, res, next) => {
    // Any website may read these responses and load the CSS and script.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  });

  router.get(
    "/news",
    validateQuery(listSchema),
    asyncHandler(async (_req, res) => {
      res.setHeader("Cache-Control", CACHE);
      res.json(await service.listLiveNews(res.locals.query));
    }),
  );

  router.get("/news.css", (_req, res) => {
    res.setHeader("Cache-Control", CACHE);
    res.type("text/css").send(CARD_CSS.trim());
  });

  router.get(
    "/news/:id",
    validateParams(idParamSchema),
    asyncHandler(async (_req, res) => {
      res.setHeader("Cache-Control", CACHE);
      res.json(await service.getLiveNews(res.locals.params.id));
    }),
  );

  router.get("/embed.js", (_req, res) => {
    res.setHeader("Cache-Control", CACHE);
    res.type("application/javascript").send(EMBED_SCRIPT);
  });

  return router;
}

/**
 * Renders live cards into every `<div data-mu-news>` on the page:
 *   <div data-mu-news="large" data-limit="6"></div>
 *   <script src="https://<api-host>/api/public/embed.js" defer></script>
 * data-mu-news picks the card design: large (standard), medium (feature) or small (list).
 * The card HTML is built and escaped by the server; the CSS is loaded once from news.css.
 */
const EMBED_SCRIPT = `(function () {
  var script = document.currentScript;
  var base = new URL(".", script ? script.src : location.href).href;
  if (!document.querySelector("link[data-mu-news-css]")) {
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = base + "news.css";
    css.setAttribute("data-mu-news-css", "");
    document.head.appendChild(css);
  }
  function render(el) {
    var variant = el.getAttribute("data-mu-news") || "large";
    if (["large", "medium", "small"].indexOf(variant) < 0) variant = "large";
    var limit = Math.min(50, Math.max(1, parseInt(el.getAttribute("data-limit") || "12", 10) || 12));
    fetch(base + "news?limit=" + limit)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        el.innerHTML = data.items.map(function (item) { return item.html[variant]; }).join("");
        el.dispatchEvent(new CustomEvent("mu-news:loaded", { detail: data }));
      })
      .catch(function (err) {
        el.dispatchEvent(new CustomEvent("mu-news:error", { detail: err }));
      });
  }
  function init() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-mu-news]"), render);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
`;
