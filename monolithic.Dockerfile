# Base is MongoDB's own image rather than a node image with MongoDB bolted on.
# Debian stretch went EOL in 2020 and bullseye in August 2026, so neither can be
# patched; this tracks whatever distribution MongoDB currently ships on.
FROM mongo:8.0

# Node 24 LTS from NodeSource, supported until April 2028. The "nodistro"
# repository is distribution agnostic, so this does not pin us to the base
# image's Ubuntu release.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -yq ca-certificates curl gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg -o /etc/apt/keyrings/nodesource.gpg --dearmor \
    && echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' \
      > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -yq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -yq nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV MONGO=mongodb://127.0.0.1:27017/octofarm
ENV OCTOFARM_PORT=4000

RUN npm install -g pm2

# Dependencies before sources, so editing a source file does not invalidate the
# npm ci layer. This used to be `COPY . /app` first, which meant every code
# change reinstalled the whole of node_modules.
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY . /app

EXPOSE 4000
WORKDIR /app

COPY docker/monolithic-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# mongod in the base image writes as the mongodb user; the entrypoint drops to
# it. Kept explicit so a future change does not silently start running the app
# as root.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4000/users/login',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

# The base image's CMD would otherwise be appended to the entrypoint as an argument.
CMD []
ENTRYPOINT ["bash", "/usr/local/bin/entrypoint.sh"]
