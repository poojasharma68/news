# Single service: the API also serves the built dashboard (SERVE_CLIENT=true).
# The Playwright image ships Chromium and its system libraries for the browser fallback;
# its version must match the playwright package in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.48.2-jammy
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Read by Vite at build time (Render passes service environment variables as build args).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_BASE_URL=
RUN NODE_ENV=production npm run build && npm prune --omit=dev

ENV NODE_ENV=production SERVE_CLIENT=true PORT=8787
EXPOSE 8787
CMD ["node", "server/index.js"]
