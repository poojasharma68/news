const BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
    this.name = "ApiError";
  }
}

let tokenProvider = async () => null;
let onUnauthorized = () => undefined;

export function configureApiAuth(provider, unauthorized) {
  tokenProvider = provider;
  onUnauthorized = unauthorized;
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  const token = await tokenProvider();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, { ...init, headers });
  } catch {
    throw new ApiError(
      "Cannot reach the server. Check your connection and that the API is running.",
      0,
    );
  }
  if (res.status === 401) onUnauthorized();
  if (res.status === 204) return undefined;

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const error = data?.error;
    if (!error && res.status >= 500 && !text) {
      // An empty 5xx comes from the dev proxy / gateway, not from the API itself.
      throw new ApiError(
        'The API server is not responding. Start it with "npm run dev" and check its terminal output (for example, missing .env settings).',
        res.status,
      );
    }
    throw new ApiError(
      error?.message ?? `Request failed (HTTP ${res.status}).`,
      res.status,
      error?.details,
    );
  }
  return data;
}

const json = (body) => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  config: () => request("/config"),
  stats: () => request("/stats"),

  submitBatch: (urls) => request("/batches", json({ urls })),
  listBatches: (limit = 10) => request(`/batches?limit=${limit}`),
  getBatch: (id) => request(`/batches/${id}`),
  retryBatch: (id) => request(`/batches/${id}/retry`, { method: "POST" }),
  cancelBatch: (id) => request(`/batches/${id}/cancel`, { method: "POST" }),

  listCards: (params) => {
    const query = new URLSearchParams();
    if (params.search) query.set("search", params.search);
    if (params.status?.length) query.set("status", params.status.join(","));
    if (params.from) query.set("from", params.from);
    if (params.to) query.set("to", params.to);
    query.set("page", String(params.page ?? 1));
    query.set("page_size", String(params.page_size ?? 20));
    if (params.sort) query.set("sort", params.sort);
    if (params.order) query.set("order", params.order);
    return request(`/cards?${query}`);
  },
  getCard: (id) => request(`/cards/${id}`),
  getCardEvents: (id) => request(`/cards/${id}/events`),
  updateCard: (id, update) =>
    request(`/cards/${id}`, { method: "PATCH", body: JSON.stringify(update) }),
  deleteCard: (id) => request(`/cards/${id}`, { method: "DELETE" }),
  retryCard: (id) => request(`/cards/${id}/retry`, { method: "POST" }),
  cancelCard: (id) => request(`/cards/${id}/cancel`, { method: "POST" }),
  uploadThumbnail: (id, file) => {
    const form = new FormData();
    form.append("thumbnail", file);
    return request(`/cards/${id}/thumbnail`, { method: "POST", body: form });
  },
  uploadLogo: (id, file) => {
    const form = new FormData();
    form.append("logo", file);
    return request(`/cards/${id}/logo`, { method: "POST", body: form });
  },

  approve: (ids) => request("/cards/approve", json({ ids })),
  retryCards: (ids) => request("/cards/retry", json({ ids })),
  publish: (ids) => request("/cards/publish", json({ ids })),
  unpublish: (ids) => request("/cards/unpublish", json({ ids })),
  exportHtml: (ids, options) =>
    request("/cards/export", json({ ids, ...options })),
};
