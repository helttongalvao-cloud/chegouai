-- v30: tipo 'combo' nas campanhas (leve X por preço fixo)
ALTER TABLE public.campanhas_estabelecimento
  ADD COLUMN IF NOT EXISTS combo_preco NUMERIC(10,2) DEFAULT 0;

ALTER TABLE public.campanhas_estabelecimento
  DROP CONSTRAINT IF EXISTS campanhas_estabelecimento_tipo_check;

ALTER TABLE public.campanhas_estabelecimento
  ADD CONSTRAINT campanhas_estabelecimento_tipo_check
  CHECK (tipo IN ('percentual', 'fixo', 'frete_gratis', 'combo'));
