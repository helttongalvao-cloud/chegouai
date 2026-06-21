-- migration_v36: OAuth Mercado Pago por lojista (split automático)
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS mp_access_token  TEXT;
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS mp_refresh_token TEXT;
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS mp_token_expires_at TIMESTAMPTZ;
