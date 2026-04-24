-- =========================================================
-- Migration v11 — Chat em tempo real + Códigos de verificação
-- chat_mensagens: comunicação cliente ↔ motoboy durante entrega
-- codigo_coleta: 3 dígitos gerado no status 'pronto', validado pelo motoboy
-- Rodar no Supabase SQL Editor
-- =========================================================

-- Código de coleta na tabela de pedidos
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS codigo_coleta TEXT;

-- Tabela de mensagens do chat
CREATE TABLE IF NOT EXISTS public.chat_mensagens (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id  UUID NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  remetente  TEXT NOT NULL CHECK (remetente IN ('cliente', 'motoboy')),
  mensagem   TEXT NOT NULL CHECK (char_length(mensagem) BETWEEN 1 AND 500),
  lida       BOOLEAN DEFAULT FALSE,
  criado_em  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_mensagens_pedido_idx ON public.chat_mensagens(pedido_id, criado_em);

-- RLS
ALTER TABLE public.chat_mensagens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat_select_cliente"
  ON public.chat_mensagens FOR SELECT
  USING (
    pedido_id IN (SELECT id FROM public.pedidos WHERE cliente_id = auth.uid())
  );

CREATE POLICY "chat_select_motoboy"
  ON public.chat_mensagens FOR SELECT
  USING (
    pedido_id IN (
      SELECT id FROM public.pedidos
      WHERE motoboy_id IN (SELECT id FROM public.motoboys WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "chat_service_role"
  ON public.chat_mensagens TO service_role
  USING (true) WITH CHECK (true);

-- Realtime precisa de REPLICA IDENTITY FULL para enviar dados completos
ALTER TABLE public.chat_mensagens REPLICA IDENTITY FULL;
