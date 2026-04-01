FROM node:25-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build
RUN pnpm install --frozen-lockfile --prod

FROM node:25-alpine
WORKDIR /app
COPY web/ web/
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/
RUN mkdir -p data
VOLUME /app/data
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
