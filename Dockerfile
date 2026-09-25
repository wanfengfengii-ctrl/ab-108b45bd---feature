# 移动式穹顶测绘平台 · 安全操作演练
# 零依赖 Node.js 应用：无需 npm install，构建可离线进行。
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test

# 构建步骤：语法校验 + 前端资源校验 + 生成 dist/ 产物
RUN npm run build \
    && addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/data && chown -R app:app /app

USER app

ENV PORT=8080 \
    DATA_DIR=/app/data

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||8080)+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["node", "src/server.js"]
