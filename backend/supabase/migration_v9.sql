-- =========================================================
-- Migration v9 — GRANT service_role em todas as tabelas
-- Corrige "permission denied" (42501) no backend
-- Rodar no Supabase SQL Editor
-- =========================================================

GRANT ALL ON public.motoboys           TO service_role;
GRANT ALL ON public.motoboys_proprios  TO service_role;
GRANT ALL ON public.pedidos            TO service_role;
GRANT ALL ON public.itens_pedido       TO service_role;
GRANT ALL ON public.estabelecimentos   TO service_role;
GRANT ALL ON public.produtos           TO service_role;
GRANT ALL ON public.profiles           TO service_role;
GRANT ALL ON public.repasses           TO service_role;
GRANT ALL ON public.grupos_complementos TO service_role;
GRANT ALL ON public.complementos       TO service_role;

-- Políticas RLS para service_role (caso FORCE RLS esteja ativo)
DROP POLICY IF EXISTS "service_role_motoboys" ON public.motoboys;
CREATE POLICY "service_role_motoboys"
  ON public.motoboys TO service_role USING (true) WITH CHECK (true);

-- Garante coluna telefone em estabelecimentos (pode não existir em DBs antigos)
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS telefone TEXT;
