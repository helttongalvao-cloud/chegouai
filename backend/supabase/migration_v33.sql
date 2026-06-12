-- migration_v33: tabela de contratos digitais

CREATE TABLE IF NOT EXISTS public.contratos (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tipo           TEXT NOT NULL CHECK (tipo IN ('motoboy', 'lojista')),
  versao         TEXT NOT NULL DEFAULT '1.0',
  nome_assinante TEXT NOT NULL,
  ip             TEXT,
  assinado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.contratos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usuario_ve_proprio_contrato"
  ON public.contratos FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "usuario_insere_proprio_contrato"
  ON public.contratos FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin_ve_todos_contratos"
  ON public.contratos FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND perfil = 'admin'
  ));

GRANT ALL ON public.contratos TO anon, authenticated, service_role;
