#!/usr/bin/env node
/**
 * migrate.js — Executa as migrations SQL no Supabase via Management API
 *
 * Uso:
 *   node migrate.js SEU_ACCESS_TOKEN
 *
 * Gere o token em: https://app.supabase.com/account/tokens → "Generate new token"
 */

const https = require('https');
const path  = require('path');

// Carrega .env manualmente (sem dependências extras)
require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8')
  .split('\n')
  .forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });

const accessToken = process.argv[2];
if (!accessToken) {
  console.error('Uso: node migrate.js SEU_ACCESS_TOKEN');
  console.error('Gere o token em: https://app.supabase.com/account/tokens');
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) {
  console.error('SUPABASE_URL não encontrada no .env');
  process.exit(1);
}

// Extrai o project ref da URL (ex: lgcepuednurxwsandgaf)
const projectRef = supabaseUrl.replace('https://', '').split('.')[0];
console.log(`\nProject ref: ${projectRef}\n`);

// Lista de migrations a executar
const migrations = [
  {
    name: 'produtos: coluna imagem_url',
    sql: `ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS imagem_url TEXT`
  },
  {
    name: 'produtos: coluna categoria',
    sql: `ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS categoria TEXT DEFAULT 'principal'`
  },
  {
    name: 'itens_pedido: coluna observacao',
    sql: `ALTER TABLE public.itens_pedido ADD COLUMN IF NOT EXISTS observacao TEXT`
  },
  {
    name: 'pedidos: coluna tipo',
    sql: `ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'normal'`
  },
  {
    name: 'pedidos: coluna lista_compras',
    sql: `ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS lista_compras TEXT`
  },
  {
    name: 'pedidos: coluna troco_para',
    sql: `ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS troco_para NUMERIC(10,2)`
  },
  {
    name: 'pedidos: coluna cupom_codigo',
    sql: `ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS cupom_codigo TEXT`
  },
  {
    name: 'pedidos: coluna desconto',
    sql: `ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS desconto NUMERIC(10,2) DEFAULT 0`
  },
  {
    name: 'pedidos: remover constraint forma_pagamento antiga',
    sql: `ALTER TABLE public.pedidos DROP CONSTRAINT IF EXISTS pedidos_forma_pagamento_check`
  },
  {
    name: 'pedidos: nova constraint forma_pagamento (dinheiro + maquininha)',
    sql: `ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_forma_pagamento_check CHECK (forma_pagamento IN ('pix', 'cartao', 'dinheiro', 'maquininha'))`
  },
  {
    name: 'estabelecimentos: coluna valor_minimo',
    sql: `ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS valor_minimo NUMERIC(10,2) DEFAULT 0`
  },
  {
    name: 'estabelecimentos: coluna horarios',
    sql: `ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS horarios JSONB`
  },
  {
    name: 'estabelecimentos: coluna whatsapp',
    sql: `ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS whatsapp TEXT`
  },
  {
    name: 'motoboys: coluna lat',
    sql: `ALTER TABLE public.motoboys ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`
  },
  {
    name: 'motoboys: coluna lng',
    sql: `ALTER TABLE public.motoboys ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`
  },
  {
    name: 'motoboys: coluna chave_pix',
    sql: `ALTER TABLE public.motoboys ADD COLUMN IF NOT EXISTS chave_pix TEXT`
  },
  {
    name: 'criar tabela avaliacoes',
    sql: `CREATE TABLE IF NOT EXISTS public.avaliacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id UUID REFERENCES public.pedidos(id) ON DELETE CASCADE,
  cliente_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  estabelecimento_id UUID REFERENCES public.estabelecimentos(id) ON DELETE SET NULL,
  nota INTEGER CHECK (nota BETWEEN 1 AND 5),
  comentario TEXT,
  criado_em TIMESTAMPTZ DEFAULT now()
)`
  },
  {
    name: 'criar tabela mensagens',
    sql: `CREATE TABLE IF NOT EXISTS public.mensagens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id UUID REFERENCES public.pedidos(id) ON DELETE CASCADE,
  remetente_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  remetente_tipo TEXT CHECK (remetente_tipo IN ('cliente','estabelecimento')),
  texto TEXT NOT NULL,
  lida BOOLEAN DEFAULT false,
  criado_em TIMESTAMPTZ DEFAULT now()
)`
  },
  {
    name: 'criar tabela cupons',
    sql: `CREATE TABLE IF NOT EXISTS public.cupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT UNIQUE NOT NULL,
  desconto_tipo TEXT CHECK (desconto_tipo IN ('percentual','fixo')),
  desconto_valor NUMERIC(10,2) NOT NULL,
  usos_max INTEGER DEFAULT 1,
  usos_atual INTEGER DEFAULT 0,
  validade TIMESTAMPTZ,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT now()
)`
  }
];

function runQuery(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql });
    const options = {
      hostname: 'api.supabase.com',
      path: `/v1/projects/${projectRef}/database/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  let ok = 0, fail = 0;

  for (const migration of migrations) {
    process.stdout.write(`  ${migration.name} ... `);
    try {
      await runQuery(migration.sql);
      console.log('✅');
      ok++;
    } catch (err) {
      console.log('❌');
      console.error(`    Erro: ${err.message.slice(0, 200)}`);
      fail++;
    }
  }

  console.log(`\n${ok} ✅  ${fail} ❌  (total: ${migrations.length})`);
  if (fail > 0) {
    console.log('\nAlgumas migrations falharam. Verifique os erros acima.');
    process.exit(1);
  } else {
    console.log('\nTodas as migrations foram aplicadas com sucesso!');
  }
}

main();
