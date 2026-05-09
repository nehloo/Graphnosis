# Graphnosis MCP Server — Mode 2 (Enterprise HTTP)
#
# Build:  docker build -t graphnosis-mcp .
# Run:    docker run -p 3001:3001 -v /your/data:/data \
#           -e MCP_TRANSPORT=http \
#           -e OPENAI_API_KEY=sk-... \
#           graphnosis-mcp
#
# Graph files in /data/*.gai are accessible via load_graph tool.
# Connect any MCP client to http://host:3001/mcp

FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies (production + tsx for runtime TS execution)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm install tsx

# Copy only the source needed for the MCP server
COPY tsconfig.json ./
COPY src/core/ ./src/core/
COPY src/mcp/ ./src/mcp/

# Data volume — mount your .gai files here
VOLUME ["/data"]

ENV MCP_TRANSPORT=http
ENV MCP_PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node_modules/.bin/tsx", "src/mcp/server.ts"]
