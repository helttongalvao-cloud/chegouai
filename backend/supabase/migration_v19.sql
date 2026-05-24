-- migration_v19: Cria tabela cupons_plataforma (cupons gerenciados pelo admin da plataforma)
CREATE TABLE IF NOT EXISTS public.cupons_plataforma (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT UNIQUE NOT NULL,
  desconto_tipo TEXT CHECK (desconto_tipo IN ('percentual', 'fixo')),
  desconto_valor NUMERIC(10,2) NOT NULL,
  usos_max INTEGER DEFAULT 1,
  usos_atual INTEGER DEFAULT 0,
  validade TIMESTAMPTZ,
  ativo BOOLEAN DEFAULT true
);

-- Garante colunas caso a tabela já exista com schema parcial
ALTER TABLE public.cupons_plataforma ADD COLUMN IF NOT EXISTS desconto_tipo TEXT;
ALTER TABLE public.cupons_plataforma ADD COLUMN IF NOT EXISTS desconto_valor NUMERIC(10,2);
ALTER TABLE public.cupons_plataforma ADD COLUMN IF NOT EXISTS usos_max INTEGER DEFAULT 1;
ALTER TABLE public.cupons_plataforma ADD COLUMN IF NOT EXISTS usos_atual INTEGER DEFAULT 0;
ALTER TABLE public.cupons_plataforma ADD COLUMN IF NOT EXISTS validade TIMESTAMPTZ;
ALTER TABLE public.cupons_plataforma ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true;
