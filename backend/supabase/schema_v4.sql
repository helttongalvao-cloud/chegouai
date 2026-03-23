-- =============================================
-- CHEGOU AÍ — v4: Push Notifications + GPS Loja
-- Execute no SQL Editor do Supabase
-- =============================================

-- Tabela de subscriptions push
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        UNIQUE NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint      TEXT        NOT NULL,
  subscription  TEXT        NOT NULL,  -- JSON completo da PushSubscription
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Coordenadas GPS dos estabelecimentos (para cálculo de frete real)
ALTER TABLE public.estabelecimentos
  ADD COLUMN IF NOT EXISTS lat DECIMAL(10,8),
  ADD COLUMN IF NOT EXISTS lng DECIMAL(11,8);

-- RLS para push_subscriptions (cada usuário gerencia apenas a sua)
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "push_sub_own" ON public.push_subscriptions
  FOR ALL USING (user_id = auth.uid());
