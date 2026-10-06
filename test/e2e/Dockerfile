# An "agent machine" for the opt-in end-to-end suite (npm run test:e2e): Claude Code,
# Codex and Antigravity on Linux, with this checkout of hoptell. Build context: repo root.
# Logins are copied in at runtime by run.mjs and never baked into the image.
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends tmux git curl ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force
RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /home/agent
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash
ENV PATH=/home/agent/.local/bin:$PATH
COPY --chown=agent:agent package.json package-lock.json hoptell/
RUN cd hoptell && npm ci --omit=dev
COPY --chown=agent:agent bin hoptell/bin
COPY --chown=agent:agent lib hoptell/lib
COPY --chown=agent:agent .mcp.json hoptell/.mcp.json
CMD ["sleep", "infinity"]
