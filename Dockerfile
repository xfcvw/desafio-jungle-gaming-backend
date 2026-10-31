FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.4-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
CMD ["bun", "run", "start"]
