-- v28: colunas de frete por km no estabelecimento
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS tipo_frete TEXT DEFAULT 'fixo' CHECK (tipo_frete IN ('fixo', 'km'));
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS frete_base NUMERIC(10,2) DEFAULT 0;
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS frete_por_km NUMERIC(10,2) DEFAULT 0;
