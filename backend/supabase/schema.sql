-- =============================================
-- CHEGOU AÍ — SCHEMA DO BANCO DE DADOS
-- =============================================
-- Execute no SQL Editor do Supabase:
-- https://app.supabase.com → SQL Editor → New query
-- =============================================

-- Habilitar extensão UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- TABELA: profiles
-- Estende a tabela auth.users do Supabase
-- =============================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nome        TEXT        NOT NULL,
  telefone    TEXT        UNIQUE,
  email       TEXT        UNIQUE,
  perfil      TEXT        NOT NULL DEFAULT 'cliente'
                          CHECK (perfil IN ('cliente', 'estabelecimento', 'motoboy', 'admin')),
  ativo       BOOLEAN     NOT NULL DEFAULT true,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger: criar perfil automaticamente ao criar usuário Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, nome, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'nome', split_part(NEW.email, '@', 1)),
    NEW.email
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================
-- TABELA: estabelecimentos
-- =============================================
CREATE TABLE IF NOT EXISTS public.estabelecimentos (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  nome           TEXT        NOT NULL,
  categoria      TEXT        NOT NULL DEFAULT 'restaurante'
                             CHECK (categoria IN ('restaurante', 'mercado', 'farmacia', 'lanche', 'bebida')),
  emoji          TEXT        NOT NULL DEFAULT '🏪',
  tempo_entrega  TEXT        NOT NULL DEFAULT '30-45 min',
  taxa_entrega   DECIMAL(10,2) NOT NULL DEFAULT 4.00,
  aberto         BOOLEAN     NOT NULL DEFAULT true,
  mp_user_id     TEXT,                         -- ID da conta Mercado Pago (para split)
  cadastro_data  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ativo          BOOLEAN     NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em  TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- TABELA: produtos
-- =============================================
CREATE TABLE IF NOT EXISTS public.produtos (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  estabelecimento_id  UUID        NOT NULL REFERENCES public.estabelecimentos(id) ON DELETE CASCADE,
  nome                TEXT        NOT NULL,
  descricao           TEXT        DEFAULT '',
  preco               DECIMAL(10,2) NOT NULL CHECK (preco > 0),
  emoji               TEXT        NOT NULL DEFAULT '🍽️',
  disponivel          BOOLEAN     NOT NULL DEFAULT true,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================
-- TABELA: motoboys
-- =============================================
CREATE TABLE IF NOT EXISTS public.motoboys (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  nome        TEXT        NOT NULL,
  telefone    TEXT,
  moto        TEXT        DEFAULT '',
  mp_user_id  TEXT,                         -- ID da conta MP (para receber taxa de entrega)
  disponivel  BOOLEAN     NOT NULL DEFAULT false,
  ativo       BOOLEAN     NOT NULL DEFAULT true,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================
-- TABELA: pedidos
-- =============================================
CREATE TABLE IF NOT EXISTS public.pedidos (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id           UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  estabelecimento_id   UUID        REFERENCES public.estabelecimentos(id) ON DELETE SET NULL,
  motoboy_id           UUID        REFERENCES public.motoboys(id) ON DELETE SET NULL,
  status               TEXT        NOT NULL DEFAULT 'pendente'
                                   CHECK (status IN ('pendente','aceito','preparando','pronto','coletado','entregue','cancelado')),
  endereco_entrega     TEXT        NOT NULL,
  telefone_cliente     TEXT,
  subtotal             DECIMAL(10,2) NOT NULL CHECK (subtotal >= 0),
  taxa_entrega         DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (taxa_entrega >= 0),
  comissao_plataforma  DECIMAL(10,2) NOT NULL DEFAULT 0,
  total                DECIMAL(10,2) NOT NULL CHECK (total >= 0),
  forma_pagamento      TEXT        NOT NULL CHECK (forma_pagamento IN ('pix', 'cartao')),
  pagamento_status     TEXT        NOT NULL DEFAULT 'pendente'
                                   CHECK (pagamento_status IN ('pendente','aguardando','aprovado','recusado','cancelado')),
  mp_payment_id        TEXT,
  mp_preference_id     TEXT,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em        TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- TABELA: itens_pedido
-- =============================================
CREATE TABLE IF NOT EXISTS public.itens_pedido (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id       UUID        NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  produto_id      UUID        REFERENCES public.produtos(id) ON DELETE SET NULL,
  nome            TEXT        NOT NULL,
  preco_unitario  DECIMAL(10,2) NOT NULL,
  quantidade      INTEGER     NOT NULL CHECK (quantidade > 0),
  subtotal        DECIMAL(10,2) NOT NULL
);

-- =============================================
-- TABELA: repasses
-- Registro de valores a pagar/pagos por pedido
-- =============================================
CREATE TABLE IF NOT EXISTS public.repasses (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id       UUID        REFERENCES public.pedidos(id) ON DELETE CASCADE,
  tipo            TEXT        NOT NULL CHECK (tipo IN ('lojista', 'motoboy', 'plataforma')),
  valor           DECIMAL(10,2) NOT NULL CHECK (valor >= 0),
  status          TEXT        NOT NULL DEFAULT 'pendente'
                              CHECK (status IN ('pendente','processando','pago','erro')),
  mp_transfer_id  TEXT,
  observacao      TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- ÍNDICES (performance)
-- =============================================
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente    ON public.pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_est        ON public.pedidos(estabelecimento_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_status     ON public.pedidos(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_criado_em  ON public.pedidos(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_produtos_est       ON public.produtos(estabelecimento_id);
CREATE INDEX IF NOT EXISTS idx_repasses_pedido    ON public.repasses(pedido_id);
CREATE INDEX IF NOT EXISTS idx_repasses_status    ON public.repasses(status);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================
ALTER TABLE public.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estabelecimentos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produtos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.motoboys          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itens_pedido      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repasses          ENABLE ROW LEVEL SECURITY;

-- profiles: usuário vê/edita apenas o próprio perfil
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- estabelecimentos: público pode listar, lojista edita o seu
CREATE POLICY "est_select_public" ON public.estabelecimentos
  FOR SELECT USING (ativo = true);

CREATE POLICY "est_update_own" ON public.estabelecimentos
  FOR UPDATE USING (user_id = auth.uid());

-- produtos: público pode listar disponíveis, lojista gerencia os seus
CREATE POLICY "produtos_select_public" ON public.produtos
  FOR SELECT USING (disponivel = true);

CREATE POLICY "produtos_manage_own" ON public.produtos
  FOR ALL USING (
    estabelecimento_id IN (
      SELECT id FROM public.estabelecimentos WHERE user_id = auth.uid()
    )
  );

-- pedidos: cliente vê os seus, estabelecimento vê os da loja
CREATE POLICY "pedidos_select_cliente" ON public.pedidos
  FOR SELECT USING (cliente_id = auth.uid());

CREATE POLICY "pedidos_insert_cliente" ON public.pedidos
  FOR INSERT WITH CHECK (cliente_id = auth.uid());

CREATE POLICY "pedidos_select_est" ON public.pedidos
  FOR SELECT USING (
    estabelecimento_id IN (
      SELECT id FROM public.estabelecimentos WHERE user_id = auth.uid()
    )
  );

-- pedidos: motoboy vê pedidos prontos disponíveis e os que foram atribuídos a ele
CREATE POLICY "pedidos_select_motoboy" ON public.pedidos
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND perfil = 'motoboy')
    AND (
      (status = 'pronto' AND motoboy_id IS NULL)
      OR motoboy_id IN (SELECT id FROM public.motoboys WHERE user_id = auth.uid())
    )
  );

-- motoboys: motoboy vê/edita apenas o próprio registro; admin vê todos
CREATE POLICY "motoboys_select_own" ON public.motoboys
  FOR SELECT USING (
    user_id = auth.uid()
    OR auth.uid() IN (SELECT id FROM public.profiles WHERE perfil = 'admin')
  );

-- Cliente pode ver lat/lng do motoboy enquanto pedido está sendo entregue
CREATE POLICY "motoboys_select_cliente_ativo" ON public.motoboys
  FOR SELECT USING (
    id IN (
      SELECT motoboy_id FROM public.pedidos
      WHERE cliente_id = auth.uid()
        AND status = 'coletado'
        AND motoboy_id IS NOT NULL
    )
  );

CREATE POLICY "motoboys_update_own" ON public.motoboys
  FOR UPDATE USING (user_id = auth.uid());

-- repasses: motoboy vê os seus; estabelecimento vê os seus; admin vê todos
CREATE POLICY "repasses_select_own" ON public.repasses
  FOR SELECT USING (
    pedido_id IN (
      SELECT id FROM public.pedidos
      WHERE
        motoboy_id IN (SELECT id FROM public.motoboys WHERE user_id = auth.uid())
        OR estabelecimento_id IN (SELECT id FROM public.estabelecimentos WHERE user_id = auth.uid())
        OR auth.uid() IN (SELECT id FROM public.profiles WHERE perfil = 'admin')
    )
  );

-- itens_pedido: via pedido
CREATE POLICY "itens_select_cliente" ON public.itens_pedido
  FOR SELECT USING (
    pedido_id IN (SELECT id FROM public.pedidos WHERE cliente_id = auth.uid())
  );

-- =============================================
-- DADOS INICIAIS — Admin padrão
-- =============================================
-- Execute DEPOIS de criar o usuário admin via Supabase Auth:
--
-- UPDATE public.profiles
-- SET perfil = 'admin'
-- WHERE email = 'seu-email-admin@example.com';
--
-- =============================================

-- =============================================
-- REALTIME (para notificações em tempo real)
-- =============================================
-- Habilitar realtime na tabela pedidos para notificações ao lojista/motoboy
ALTER PUBLICATION supabase_realtime ADD TABLE public.pedidos;
ALTER PUBLICATION supabase_realtime ADD TABLE public.repasses;
ALTER PUBLICATION supabase_realtime ADD TABLE public.motoboys;

-- =============================================
-- MIGRATIONS — novas features
-- =============================================

-- Produtos: imagem e categoria
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS imagem_url TEXT;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS categoria TEXT DEFAULT 'principal';

-- Itens do pedido: observação do cliente
ALTER TABLE public.itens_pedido ADD COLUMN IF NOT EXISTS observacao TEXT;

-- Pedidos: tipo, lista de compras, troco, cupom, desconto
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'normal';
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS lista_compras TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS troco_para NUMERIC(10,2);
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS cupom_codigo TEXT;
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS desconto NUMERIC(10,2) DEFAULT 0;

-- Pedidos: ampliar forma_pagamento para dinheiro e maquininha
ALTER TABLE public.pedidos DROP CONSTRAINT IF EXISTS pedidos_forma_pagamento_check;
ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_forma_pagamento_check
  CHECK (forma_pagamento IN ('pix', 'cartao', 'dinheiro', 'maquininha'));

-- Estabelecimentos: valor mínimo, horários, whatsapp
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS valor_minimo NUMERIC(10,2) DEFAULT 0;
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS horarios JSONB;
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS whatsapp TEXT;

-- Motoboys: lat/lng (legado Supabase) e chave_pix
ALTER TABLE public.motoboys ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE public.motoboys ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE public.motoboys ADD COLUMN IF NOT EXISTS chave_pix TEXT;

-- Migração: Mercado Pago → Asaas
-- Pedidos: ID da cobrança Asaas (substitui mp_payment_id e mp_preference_id)
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS asaas_payment_id TEXT;

-- Estabelecimentos: wallet Asaas para split automático (substitui mp_user_id OAuth)
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS asaas_wallet_id TEXT;

-- Tabela de avaliações
CREATE TABLE IF NOT EXISTS public.avaliacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id UUID REFERENCES public.pedidos(id) ON DELETE CASCADE,
  cliente_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  estabelecimento_id UUID REFERENCES public.estabelecimentos(id) ON DELETE SET NULL,
  nota INTEGER CHECK (nota BETWEEN 1 AND 5),
  comentario TEXT,
  criado_em TIMESTAMPTZ DEFAULT now()
);

-- Tabela de mensagens/chat
CREATE TABLE IF NOT EXISTS public.mensagens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id UUID REFERENCES public.pedidos(id) ON DELETE CASCADE,
  remetente_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  remetente_tipo TEXT CHECK (remetente_tipo IN ('cliente','estabelecimento')),
  texto TEXT NOT NULL,
  lida BOOLEAN DEFAULT false,
  criado_em TIMESTAMPTZ DEFAULT now()
);

-- Tabela de cupons de desconto
CREATE TABLE IF NOT EXISTS public.cupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT UNIQUE NOT NULL,
  desconto_tipo TEXT CHECK (desconto_tipo IN ('percentual','fixo')),
  desconto_valor NUMERIC(10,2) NOT NULL,
  usos_max INTEGER DEFAULT 1,
  usos_atual INTEGER DEFAULT 0,
  validade TIMESTAMPTZ,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT now()
);
