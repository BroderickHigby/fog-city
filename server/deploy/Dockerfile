# The Fog City relay (server/README.md). Build from the repository root:
#   docker build -f server/deploy/Dockerfile -t fog-city-relay .
#   docker run --rm -p 8787:8787 -e ALLOWED_ORIGINS=https://your-game.example fog-city-relay
# The image holds the sim source, the relay and the SF world's simulation files (no models).
FROM node:22.22.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node content ./content
COPY --chown=node:node server ./server
# .dockerignore keeps rendered models (*.glb), far cells and other worlds out of the context.
COPY --chown=node:node public/tiles/sf ./public/tiles/sf
# A mounted volume (/data on Fly) arrives owned by root: the entrypoint hands it to the node user,
# then drops to that user before starting the relay.
RUN mkdir -p /data && chown node:node /data
# Fly.io, Render and most hosts route to $PORT; listen on every interface inside the container.
ENV HOST=0.0.0.0 PORT=8787 RELAY_WORLDS=sf NODE_OPTIONS=--max-old-space-size=1536
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/bin/sh", "-c", "chown node:node /data 2>/dev/null || true; exec setpriv --reuid=node --regid=node --init-groups \"$@\"", "relay"]
CMD ["node", "server/main.ts"]
