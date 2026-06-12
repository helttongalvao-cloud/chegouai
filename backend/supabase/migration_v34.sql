-- migration_v34: Kit Especial — adiciona tipo 'kit' e coluna kit_descricao
ALTER TABLE public.campanhas_estabelecimento ADD COLUMN IF NOT EXISTS kit_descricao TEXT;

ALTER TABLE public.campanhas_estabelecimento
  DROP CONSTRAINT IF EXISTS campanhas_estabelecimento_tipo_check;

ALTER TABLE public.campanhas_estabelecimento
  ADD CONSTRAINT campanhas_estabelecimento_tipo_check
  CHECK (tipo IN ('percentual', 'fixo', 'frete_gratis', 'combo', 'kit'));
