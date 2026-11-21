# ============================================
# Dockerfile for NestJS Monorepo
# Supports: bidding-service, notification-service
# Usage: docker build --build-arg APP=bidding -t backhaulbid-bidding .
# ============================================

FROM node:20-alpine
WORKDIR /app

ARG APP=bidding

# Copy dependency configs
COPY package.json package-lock.json* ./

# Install dependencies (including devDependencies for build)
RUN npm install --legacy-peer-deps

# Copy source files
COPY . .

# Build the specific app
RUN npm run build:${APP}

# Prune devDependencies to keep the runtime small
RUN npm prune --production && chown -R node:node /app

USER node

ARG PORT=3001
EXPOSE ${PORT}

ENV APP=${APP}
CMD ["sh", "-c", "exec node dist/apps/${APP}/main.js"]
