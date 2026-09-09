FROM node:14.16-stretch

# Debian Stretch is EOL; its mirrors were pulled from deb.debian.org/security.debian.org.
# Point apt at the permanent archive and stop checking Release file expiry.
RUN echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/10no--check-valid-until \
    && printf 'deb http://archive.debian.org/debian stretch main\ndeb http://archive.debian.org/debian-security stretch/updates main\n' > /etc/apt/sources.list

# Update Local Repository Index
RUN apt-get update
# Upgrade packages in the base image and apply security updates
RUN DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -yq
# Install package utils
RUN DEBIAN_FRONT=noninteractive apt-get install -yq apt-utils
# Install MongoDB
RUN DEBIAN_FRONT=noninteractive apt-get install -yq ca-certificates
RUN wget -qO - https://www.mongodb.org/static/pgp/server-4.4.asc | apt-key add
RUN echo 'deb http://repo.mongodb.org/apt/debian stretch/mongodb-org/4.4 main' | tee /etc/apt/sources.list.d/mongodb.list
RUN apt-get update
RUN DEBIAN_FRONTEND=noninteractive apt-get install -yq mongodb-org

# Remove package files fetched for install
RUN apt-get clean
# Remove unwanted files
RUN rm -rf /var/lib/apt/lists/

COPY . /app
WORKDIR /app/server

ENV NODE_ENV=production
ENV MONGO=mongodb://127.0.0.1:27017/octofarm

# Pinned: npm's current major requires Node 22+, but this image is on Node 14.
RUN npm install -g npm@8
RUN npm install -g pm2

RUN npm ci --omit=dev

EXPOSE 4000
WORKDIR /app

COPY docker/monolithic-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["bash", "/usr/local/bin/entrypoint.sh"]
