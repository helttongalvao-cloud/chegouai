-- migration_v35: Suporte a produtos vendidos por peso (açougue, peixaria, etc.)
-- itens_pedido.quantidade era INTEGER, o que truncava valores decimais (ex: 0.5 kg → 0)
ALTER TABLE public.itens_pedido
  ALTER COLUMN quantidade TYPE NUMERIC(10,3);
