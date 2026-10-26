/**
 * API authentication. In "supabase" mode the dashboard signs in with Supabase Auth and sends the
 * access token; the server verifies it with Supabase and checks the email against ADMIN_EMAILS
 * (exact addresses, or "@domain.com" entries for a whole domain).
 * "none" mode is for local development only and is rejected in production by config.ts.
 */
import { createHash } from "node:crypto";
import { HttpError } from "../lib/errors.js";

const CACHE_TTL_MS = 60_000;

export function isAdminEmail(email, allowList) {
  const normalized = email.trim().toLowerCase();
  return allowList.some((entry) =>
    entry.startsWith("@") ? normalized.endsWith(entry) : normalized === entry,
  );
}

export function createAuthMiddleware(options) {
  if (options.mode === "none") {
    return (_req, res, next) => {
      res.locals.user = { id: "local-dev", email: "local-dev@localhost" };
      next();
    };
  }
  if (!options.supabase)
    throw new Error("Supabase client is required for AUTH_MODE=supabase.");
  if (options.adminEmails.length === 0)
    throw new Error(
      "ADMIN_EMAILS must list at least one address or @domain for AUTH_MODE=supabase.",
    );

  const cache = new Map();
  const supabase = options.supabase;

  return async (req, res, next) => {
    try {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token) throw new HttpError(401, "Sign in to continue.");

      const cacheKey = createHash("sha256").update(token).digest("hex");
      const cached = cache.get(cacheKey);
      let user;
      if (cached && cached.expires > Date.now()) {
        user = cached.user;
      } else {
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data.user?.email)
          throw new HttpError(401, "Your session has expired. Sign in again.");
        user = { id: data.user.id, email: data.user.email };
        if (cache.size > 500) cache.clear();
        cache.set(cacheKey, { user, expires: Date.now() + CACHE_TTL_MS });
      }

      if (!isAdminEmail(user.email, options.adminEmails))
        throw new HttpError(
          403,
          "Your account is not authorised to use this dashboard.",
        );
      res.locals.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
