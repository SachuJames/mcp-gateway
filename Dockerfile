FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY demo-servers ./demo-servers
COPY dashboard/dist ./dashboard/dist
ENV MCP_GW_PORT=8080 MCP_GW_HOST=0.0.0.0 MCP_GW_LOG_DIR=/app/logs
EXPOSE 8080
CMD ["node", "dist/index.js"]
