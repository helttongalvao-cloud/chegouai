-- v31: candidaturas de motoboy
CREATE TABLE IF NOT EXISTS public.motoboy_candidatos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Dados pessoais
  nome            TEXT NOT NULL,
  cpf             TEXT NOT NULL,
  nascimento      DATE NOT NULL,
  email           TEXT,
  whatsapp        TEXT NOT NULL,
  cidade          TEXT NOT NULL,
  tipo_veiculo    TEXT NOT NULL CHECK (tipo_veiculo IN ('moto','bicicleta','carro')),
  placa           TEXT,
  chave_pix       TEXT NOT NULL,
  banco           TEXT,

  -- Triagem
  disponivel_noite      BOOLEAN NOT NULL DEFAULT FALSE,
  horas_por_dia         TEXT NOT NULL,
  experiencia_anterior  BOOLEAN NOT NULL DEFAULT FALSE,
  experiencia_detalhes  TEXT,
  motivo_chegou         TEXT,
  tem_smartphone        BOOLEAN NOT NULL DEFAULT TRUE,
  conhece_ruas          BOOLEAN NOT NULL DEFAULT TRUE,
  tem_restricao         BOOLEAN NOT NULL DEFAULT FALSE,
  restricao_detalhes    TEXT,

  -- Documentos (URLs)
  doc_cnh_frente        TEXT,
  doc_cnh_verso         TEXT,
  doc_crlv              TEXT,
  doc_comprovante       TEXT,
  doc_selfie_cnh        TEXT,

  -- Avaliação
  score                 INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado','reprovado')),
  aprovado_em           TIMESTAMPTZ,
  reprovado_em          TIMESTAMPTZ,
  obs_admin             TEXT,

  -- Referência ao motoboy criado após aprovação
  motoboy_id            UUID REFERENCES public.motoboys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_candidatos_status ON public.motoboy_candidatos(status);
CREATE INDEX IF NOT EXISTS idx_candidatos_criado ON public.motoboy_candidatos(criado_em DESC);

-- RLS: apenas admin pode ver/editar; insert público (candidatura)
ALTER TABLE public.motoboy_candidatos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin full access candidatos"
  ON public.motoboy_candidatos FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.usuarios
      WHERE id = auth.uid() AND perfil = 'admin'
    )
  );

CREATE POLICY "insert candidatura public"
  ON public.motoboy_candidatos FOR INSERT
  WITH CHECK (true);
