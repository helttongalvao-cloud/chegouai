-- v32: pré-formulário lojista + fila de WhatsApp agendados (onboarding)

-- ─── Tabela: lojista_candidatos ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lojista_candidatos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Contato
  nome            TEXT NOT NULL,
  whatsapp        TEXT NOT NULL,
  cidade          TEXT NOT NULL,

  -- Negócio
  tipo_negocio    TEXT NOT NULL,
  descricao       TEXT,

  -- Gestão
  status          TEXT NOT NULL DEFAULT 'novo'
                  CHECK (status IN ('novo','contatado','aprovado','reprovado')),
  calendly_link   TEXT,
  obs_admin       TEXT,
  aprovado_em     TIMESTAMPTZ,
  reprovado_em    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_loj_cand_status  ON public.lojista_candidatos(status);
CREATE INDEX IF NOT EXISTS idx_loj_cand_criado  ON public.lojista_candidatos(criado_em DESC);

-- RLS: admin acessa tudo; insert público
ALTER TABLE public.lojista_candidatos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin full lojista_candidatos"
  ON public.lojista_candidatos FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND perfil = 'admin'
    )
  );

CREATE POLICY "insert lojista candidatura public"
  ON public.lojista_candidatos FOR INSERT
  WITH CHECK (true);

-- ─── Tabela: whatsapp_agendados ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_agendados (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviar_em       TIMESTAMPTZ NOT NULL,

  para            TEXT NOT NULL,
  mensagem        TEXT NOT NULL,
  tipo            TEXT NOT NULL,     -- 'onb_d1', 'onb_d2', etc.
  referencia_id   UUID,              -- FK solto (sem constraint) para estabelecimento ou candidato

  enviado         BOOLEAN NOT NULL DEFAULT FALSE,
  enviado_em      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wpp_ag_enviar ON public.whatsapp_agendados(enviar_em)
  WHERE enviado = FALSE;

-- RLS: somente backend (service_role) acessa; desabilita acesso anon
ALTER TABLE public.whatsapp_agendados ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full whatsapp_agendados"
  ON public.whatsapp_agendados FOR ALL
  USING (auth.role() = 'service_role');
