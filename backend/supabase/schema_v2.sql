-- =============================================
-- CHEGOU AÍ — NOVAS TABELAS PARA FEATURES v2
-- Execute no SQL Editor do Supabase
-- =============================================

-- 1. Tabela de avaliações
CREATE TABLE IF NOT EXISTS public.avaliacoes (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id           UUID        REFERENCES public.pedidos(id) ON DELETE CASCADE,
  cliente_id          UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  estabelecimento_id  UUID        REFERENCES public.estabelecimentos(id) ON DELETE CASCADE,
  nota                INTEGER     NOT NULL CHECK (nota >= 1 AND nota <= 5),
  comentario          TEXT        DEFAULT '',
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabela de mensagens (chat)
CREATE TABLE IF NOT EXISTS public.mensagens (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id           UUID        REFERENCES public.pedidos(id) ON DELETE CASCADE,
  remetente_id        UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  remetente_tipo      TEXT        NOT NULL CHECK (remetente_tipo IN ('cliente', 'estabelecimento')),
  texto               TEXT        NOT NULL,
  lida                BOOLEAN     NOT NULL DEFAULT false,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Adicionar colunas ao estabelecimentos
ALTER TABLE public.estabelecimentos
  ADD COLUMN IF NOT EXISTS horario_abertura TEXT DEFAULT '08:00',
  ADD COLUMN IF NOT EXISTS horario_fechamento TEXT DEFAULT '22:00';

-- 4. Adicionar coluna de imagem aos produtos
ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS imagem_url TEXT DEFAULT '';

-- 5. Adicionar tipo de pedido (normal ou lista)
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'normal' CHECK (tipo IN ('normal', 'lista')),
  ADD COLUMN IF NOT EXISTS lista_compras TEXT DEFAULT '';
