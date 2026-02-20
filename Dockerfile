FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV IN_DOCKER=1

COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src

RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm prune --prod

ENTRYPOINT ["node", "dist/cli.js"]
