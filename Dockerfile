# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies change less often than the code: copying the manifest first
# keeps this layer cached across builds.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------- production dependencies ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
  PORT=4000 \
  HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The official image already ships a "node" user; running as root would be pointless.
USER node

EXPOSE 4000

# Uses Node itself (native fetch) so the image does not need curl/wget.
# /health answers 503 when a configured provider is down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
