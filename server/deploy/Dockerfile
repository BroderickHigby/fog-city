FROM node:24.4.1-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml ./
RUN --mount=type=secret,id=build-ca \
    if [ -f /run/secrets/build-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build-ca; fi; \
    corepack enable && corepack pnpm install --frozen-lockfile --prod
COPY --chown=node:node src ./src
COPY --chown=node:node server ./server
COPY --chown=node:node public/tiles ./public/tiles
USER node
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/main.ts"]
