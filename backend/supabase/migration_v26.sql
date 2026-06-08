-- v26: preço promocional por produto + endereços salvos no perfil + foto de capa da loja
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS preco_promocional NUMERIC(10,2) DEFAULT NULL;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS enderecos JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS foto_capa_url TEXT DEFAULT NULL;
