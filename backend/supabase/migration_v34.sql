-- migration_v34: Kit Especial — nova coluna kit_descricao em campanhas_estabelecimento
ALTER TABLE public.campanhas_estabelecimento ADD COLUMN IF NOT EXISTS kit_descricao TEXT;
