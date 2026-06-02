-- =============================================
-- Migration v20 — Convites de parceiros
-- Tabela configuracoes (usada para tokens de convite)
-- Colunas extras em estabelecimentos
-- =============================================

-- Tabela de configurações/convites
CREATE TABLE IF NOT EXISTS public.configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Colunas adicionais em estabelecimentos (cadastro via convite)
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS tipo_entrega TEXT DEFAULT 'app';
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS estado TEXT;
