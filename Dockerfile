# Property Manager CRM – production image
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# All accounts, CRM data and uploaded documents live in /data: mount a volume here.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
