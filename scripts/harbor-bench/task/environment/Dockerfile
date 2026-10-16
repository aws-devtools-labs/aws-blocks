FROM node:22.23.3-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 curl git procps util-linux tmux \
    && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm install --global @anthropic-ai/claude-code@2.1.296 \
    && mkdir -p /opt/verifier \
    && npm install --prefix /opt/verifier playwright@1.58.2 \
    && /opt/verifier/node_modules/.bin/playwright install --with-deps chromium

COPY registry /opt/registry
COPY bench /opt/bench
RUN mkdir -p /app /var/lib/harbor-verifier \
    && chown node:node /app \
    && chmod 700 /var/lib/harbor-verifier \
    && printf '@aws-blocks:registry=http://localhost:4873/registry/\nregistry=https://registry.npmjs.org/\naudit=false\nfund=false\nupdate-notifier=false\n' > /etc/bench-npmrc \
    && touch /etc/bench-npm-globalrc \
    && chmod -R a-w /opt/registry /opt/bench /etc/bench-npmrc /etc/bench-npm-globalrc

ENV HOME=/home/node \
    NPM_CONFIG_USERCONFIG=/etc/bench-npmrc \
    NPM_CONFIG_GLOBALCONFIG=/etc/bench-npm-globalrc \
    NPM_CONFIG_CACHE=/home/node/.npm \
    AWS_EC2_METADATA_DISABLED=true \
    DISABLE_AUTOUPDATER=1 \
    BLOCKS_DISABLE_TELEMETRY=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
WORKDIR /app
