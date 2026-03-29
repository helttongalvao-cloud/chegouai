-- Migration v5 — foto_url no estabelecimento
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS foto_url TEXT;
