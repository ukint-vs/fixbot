FROM oven/bun:latest

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock ./

# Copy all workspace packages
COPY packages/ packages/

# Install production dependencies
RUN bun install --production --frozen-lockfile

# Bun runs TypeScript directly — no build step needed
ENTRYPOINT ["bun", "run", "packages/coding-agent/src/cli.ts", "daemon", "start", "--foreground"]
