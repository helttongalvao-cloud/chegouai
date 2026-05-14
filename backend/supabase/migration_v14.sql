-- migration_v14: Controle de estoque por produto
-- NULL = sem controle (ilimitado), INTEGER >= 0 = quantidade disponível

ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS estoque INTEGER DEFAULT NULL;

COMMENT ON COLUMN public.produtos.estoque IS
  'Quantidade em estoque. NULL = sem controle (ilimitado). 0 = esgotado.';
