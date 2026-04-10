-- Migration v6 — Pagar.me: recipient_id no estabelecimento e order_id no pedido
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS pagarme_recipient_id TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS pagarme_order_id TEXT;
