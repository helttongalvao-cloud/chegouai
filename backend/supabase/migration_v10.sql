-- =========================================================
-- Migration v10 — RLS policies para tabela pedidos
-- Sem isso o Realtime não dispara para lojista nem cliente
-- Rodar no Supabase SQL Editor
-- =========================================================

-- Cliente vê os próprios pedidos
CREATE POLICY "pedidos_select_cliente"
  ON public.pedidos FOR SELECT
  USING (cliente_id = auth.uid());

-- Estabelecimento vê os pedidos da sua loja
CREATE POLICY "pedidos_select_est"
  ON public.pedidos FOR SELECT
  USING (
    estabelecimento_id IN (
      SELECT id FROM public.estabelecimentos WHERE user_id = auth.uid()
    )
  );

-- Motoboy vê pedidos prontos disponíveis e os atribuídos a ele
CREATE POLICY "pedidos_select_motoboy"
  ON public.pedidos FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND perfil = 'motoboy')
    AND (
      (status = 'pronto' AND motoboy_id IS NULL)
      OR motoboy_id IN (SELECT id FROM public.motoboys WHERE user_id = auth.uid())
    )
  );

-- service_role — acesso total (backend)
CREATE POLICY "pedidos_service_role"
  ON public.pedidos TO service_role
  USING (true) WITH CHECK (true);

-- Habilitar REPLICA IDENTITY FULL para Realtime receber os dados completos
ALTER TABLE public.pedidos REPLICA IDENTITY FULL;
