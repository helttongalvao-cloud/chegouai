# Chegou Aí — Guia de Deploy em Produção

## Pré-requisitos

- Conta no [Supabase](https://supabase.com) (grátis)
- Conta no [Mercado Pago](https://www.mercadopago.com.br/developers) (conta PJ recomendada)
- Conta no [Railway](https://railway.app) (grátis com $5/mês de crédito)
- [Railway CLI](https://docs.railway.app/develop/cli) instalado: `npm i -g @railway/cli`
- Git configurado

---

## PASSO 1 — Supabase: criar projeto e banco

### 1.1 Criar projeto

1. Acesse [app.supabase.com](https://app.supabase.com) → **New project**
2. Nome: `chegouai`
3. Senha do banco: gere uma forte e guarde
4. Região: **South America (São Paulo)** — mais próximo de Guajará-AM
5. Aguarde ~2 min a criação

### 1.2 Executar o schema

1. No painel do Supabase → **SQL Editor** → **New query**
2. Cole o conteúdo de `backend/supabase/schema.sql`
3. Clique em **Run**
4. Confirme que não há erros no output

### 1.3 Habilitar Realtime nas tabelas

1. Supabase → **Database** → **Replication**
2. Em **Source** ative as tabelas: `pedidos` e `repasses`
   - (Ou rodar no SQL Editor):
   ```sql
   ALTER PUBLICATION supabase_realtime ADD TABLE pedidos;
   ALTER PUBLICATION supabase_realtime ADD TABLE repasses;
   ```

### 1.4 Coletar as credenciais

Supabase → **Project Settings** → **API**

Copie:
- **Project URL** → `SUPABASE_URL`
- **anon / public key** → `SUPABASE_ANON_KEY`
- **service_role / secret key** → `SUPABASE_SERVICE_KEY` ⚠️ nunca expor ao frontend

---

## PASSO 2 — Mercado Pago: configurar credenciais

### 2.1 Criar aplicação

1. [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers) → **Suas integrações** → **Criar aplicação**
2. Nome: `ChegouAi`
3. Modelo de integração: **Pagamentos online**
4. Produto: **Checkout Pro** + **Pagamentos transparentes (Pix)**

### 2.2 Coletar credenciais de PRODUÇÃO

Dentro da aplicação → aba **Credenciais de produção**:

| Campo no .env | Onde encontrar |
|---|---|
| `MP_ACCESS_TOKEN` | Access Token (começa com `APP_USR-`) |
| `MP_PUBLIC_KEY` | Public Key (começa com `APP_USR-`) |
| `MP_PLATAFORMA_USER_ID` | Seu User ID — aparece na URL do painel ou em **Dados da conta** |

> Para testes use as credenciais de **sandbox** (prefixo `TEST-`).
> Mude para produção antes de cobrar clientes reais.

### 2.3 Configurar webhook

1. MP Developers → sua aplicação → **Webhooks** → **Configurar notificações**
2. URL: `https://SEU_DOMINIO/api/payments/webhook`
3. Eventos: marque **Pagamentos**
4. Após salvar, copie o **Segredo** → `MP_WEBHOOK_SECRET`

---

## PASSO 3 — Criar o arquivo .env de produção

```bash
cd backend
cp .env.example .env
```

Edite `.env` com os valores reais:

```env
PORT=3000
NODE_ENV=production
BASE_URL=https://SEU_DOMINIO
FRONTEND_URL=https://SEU_DOMINIO

SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

MP_ACCESS_TOKEN=APP_USR-0000000000000000-000000-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-000000000
MP_PUBLIC_KEY=APP_USR-00000000-0000-0000-0000-000000000000
MP_PLATAFORMA_USER_ID=123456789

WEBHOOK_URL=https://SEU_DOMINIO
MP_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

JWT_SECRET=$(openssl rand -hex 32)
```

> Gerar o JWT_SECRET no terminal: `openssl rand -hex 32`

---

## PASSO 4 — Criar usuário admin no Supabase

O primeiro admin precisa ser criado manualmente, pois não há rota de registro público para admin.

No **SQL Editor** do Supabase:

```sql
-- 1. Criar usuário no Supabase Auth
SELECT supabase_admin.create_user(
  '{"email": "admin@chegouai.app", "password": "SENHA_FORTE_AQUI", "email_confirm": true}'::json
);
```

Ou pelo painel: **Authentication** → **Users** → **Add user** → preencha e-mail + senha.

Depois, ainda no SQL Editor, pegue o UUID gerado e insira o perfil:

```sql
-- 2. Inserir perfil admin (substitua o UUID pelo id do usuário criado)
INSERT INTO profiles (id, nome, telefone, email, perfil, ativo)
VALUES (
  'UUID-DO-USUARIO-AQUI',
  'Admin Chegou Aí',
  '97900000000',
  'admin@chegouai.app',
  'admin',
  true
);
```

---

## PASSO 5 — Deploy no Railway

Railway é a opção mais simples: detecta o `Dockerfile` automaticamente e não requer configuração manual de servidor.

### 5.1 Login e inicialização

```bash
railway login
cd /caminho/para/chegouai
railway init
# Escolha: "Create new project" → nome: chegouai
```

### 5.2 Configurar variáveis de ambiente

```bash
# Navegar para a pasta do backend (onde está o Dockerfile)
cd backend

# Subir cada variável do .env para o Railway
railway variables set \
  PORT=3000 \
  NODE_ENV=production \
  BASE_URL=https://SEU_DOMINIO \
  FRONTEND_URL=https://SEU_DOMINIO \
  SUPABASE_URL="https://xxxx.supabase.co" \
  SUPABASE_ANON_KEY="eyJ..." \
  SUPABASE_SERVICE_KEY="eyJ..." \
  MP_ACCESS_TOKEN="APP_USR-..." \
  MP_PUBLIC_KEY="APP_USR-..." \
  MP_PLATAFORMA_USER_ID="123456789" \
  WEBHOOK_URL="https://SEU_DOMINIO" \
  MP_WEBHOOK_SECRET="xxxx" \
  JWT_SECRET="xxxx"
```

Ou importe direto do arquivo (mais fácil):
```bash
railway variables --set-from-file .env
```

### 5.3 Fazer o deploy

```bash
# Dentro da pasta backend/
railway up
```

O Railway vai:
1. Detectar o `Dockerfile`
2. Buildar a imagem
3. Subir o container
4. Fornecer uma URL pública (ex: `chegouai.up.railway.app`)

### 5.4 Domínio customizado (opcional)

Railway → seu projeto → **Settings** → **Domains** → **Custom domain**

1. Adicione seu domínio (ex: `app.chegouai.com.br`)
2. Configure o DNS do seu provedor:
   ```
   CNAME  app  →  chegouai.up.railway.app
   ```
3. Railway provisiona SSL automaticamente (Let's Encrypt)

---

## PASSO 6 — Atualizar URLs após ter o domínio

Assim que tiver a URL final, atualize no Railway:

```bash
railway variables set \
  BASE_URL="https://app.chegouai.com.br" \
  FRONTEND_URL="https://app.chegouai.com.br" \
  WEBHOOK_URL="https://app.chegouai.com.br"
```

E atualize também no painel do Mercado Pago:
- Webhook URL → `https://app.chegouai.com.br/api/payments/webhook`

---

## PASSO 7 — Checklist pós-deploy

Teste cada item em ordem:

### Backend
- [ ] `GET https://SEU_DOMINIO/api/health` → `{"status":"ok"}`
- [ ] `GET https://SEU_DOMINIO/api/config` → retorna `supabaseUrl` e `mpPublicKey` preenchidos
- [ ] `GET https://SEU_DOMINIO/` → carrega o app (HTML)

### Autenticação
- [ ] Registro de cliente funciona
- [ ] Login de cliente redireciona para home com estabelecimentos
- [ ] Login de admin redireciona para painel admin

### Estabelecimentos
- [ ] Criar loja pelo painel admin → aparece na lista de estabelecimentos
- [ ] Lojista consegue ver pedidos abertos
- [ ] Lojista consegue adicionar produto
- [ ] Realtime: abrir painel lojista em um browser e criar pedido em outro → pedido aparece sem atualizar página

### Pagamentos (sandbox primeiro)
- [ ] Criar pedido → escolher Pix → QR Code aparece
- [ ] Simular pagamento aprovado no sandbox MP → pedido muda para "aceito"
- [ ] Webhook recebe notificação (checar logs: `railway logs`)
- [ ] Criar pedido → escolher cartão → redireciona para checkout MP

### Motoboy
- [ ] Motoboy vê pedido com status "pronto"
- [ ] Aceitar entrega → status muda para "coletado"
- [ ] Confirmar entrega → status muda para "entregue"

---

## Comandos úteis em produção

```bash
# Ver logs em tempo real
railway logs --tail

# Redeploy após push
railway up

# Ver variáveis configuradas
railway variables

# Abrir o app no browser
railway open
```

---

## Alternativa: deploy manual com Docker

Se preferir VPS (DigitalOcean, Hostinger, etc.):

```bash
# Na sua VPS (Ubuntu)
git clone <repo> chegouai
cd chegouai/backend
cp .env.example .env
# edite o .env com os valores reais

# Build e run
docker build -t chegouai .
docker run -d \
  --name chegouai \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  chegouai

# Nginx como proxy reverso (recomendado)
# /etc/nginx/sites-available/chegouai:
# server {
#   listen 80;
#   server_name app.chegouai.com.br;
#   location / { proxy_pass http://localhost:3000; }
# }
# sudo certbot --nginx -d app.chegouai.com.br
```

---

## Troubleshooting comum

| Erro | Causa provável | Solução |
|---|---|---|
| `MP_ACCESS_TOKEN não definido` | `.env` não carregou | Verificar variáveis no Railway |
| `SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios` | Variáveis faltando | `railway variables set ...` |
| Webhook retorna 401/403 | `MP_WEBHOOK_SECRET` errado | Conferir o segredo no painel MP |
| Realtime não funciona | Tabela não adicionada à publicação | Rodar o SQL do Passo 1.3 |
| CORS error no browser | `FRONTEND_URL` diferente do domínio | Atualizar variável e redeploy |
| Pedido cria mas QR não aparece | Credenciais MP em sandbox/produção erradas | Conferir prefixo `TEST-` vs `APP_USR-` |
