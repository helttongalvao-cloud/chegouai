-- v29: suporte a variações e galeria de fotos por produto (e-commerce)
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS variacoes JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS galeria JSONB DEFAULT '[]'::jsonb;
