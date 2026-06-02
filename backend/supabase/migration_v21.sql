-- =============================================
-- Migration v21 — Histórico de status do pedido
-- Para timeline de rastreio estilo Amazon (encomendas)
-- =============================================
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS historico_status JSONB DEFAULT '{}'::jsonb;
