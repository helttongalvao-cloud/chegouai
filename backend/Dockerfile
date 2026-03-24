FROM node:20-alpine

WORKDIR /app

# Dependências nativas necessárias para web-push e compilação
RUN apk add --no-cache python3 make g++ libatomic

# Instalar dependências de produção primeiro (aproveita cache de layer)
COPY package*.json ./
RUN npm ci --only=production

# Copiar código
COPY . .

# Usuário sem privilégios
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
