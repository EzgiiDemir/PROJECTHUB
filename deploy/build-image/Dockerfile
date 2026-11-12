# Project Hub build image: PHP 8.4 (Laravel extensions) + Composer 2 + Node.js 22, for BUILD_EXECUTOR=container.
# Install, build and test commands of trusted projects run here as UID 1000 with a read-only root filesystem,
# no capabilities and (except dependency installation) no network. Build once on the worker host:
#   docker build -t projecthub/build:php8.4-node22 deploy/build-image
# The worker never pulls images during a job (--pull never).
FROM node:22-bookworm-slim AS node

FROM php:8.4-cli-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip ca-certificates libzip-dev libpng-dev libjpeg62-turbo-dev \
    libfreetype6-dev libicu-dev libpq-dev libsqlite3-dev libonig-dev \
 && docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install -j"$(nproc)" pdo_mysql pdo_pgsql pdo_sqlite zip gd intl bcmath exif pcntl opcache \
 && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
# Node without replacing PHP's own /usr/local tree.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && printf 'memory_limit=1G\nopcache.enable_cli=1\n' > /usr/local/etc/php/conf.d/projecthub.ini \
 # Package caches live on a per-project Docker volume mounted here; a new volume copies this owner.
 && mkdir -p /cache/npm /cache/composer /home/builder \
 && chown -R 1000:1000 /cache /home/builder
ENV HOME=/home/builder
USER 1000:1000
RUN node --version && npm --version && php --version && composer --version
