-- v25: PIN do operador (acesso de funcionário sem criar conta)
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS pin_operador TEXT DEFAULT NULL;
