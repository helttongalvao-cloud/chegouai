-- =========================================================
-- Migration v13 — Favoritos
-- Rodar no Supabase SQL Editor
-- =========================================================

CREATE TABLE IF NOT EXISTS public.favoritos (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  estabelecimento_id  UUID        NOT NULL REFERENCES public.estabelecimentos(id) ON DELETE CASCADE,
  criado_em           TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, estabelecimento_id)
);

ALTER TABLE public.favoritos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "favoritos_proprio"
  ON public.favoritos
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "favoritos_service_role"
  ON public.favoritos TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS favoritos_user_idx ON public.favoritos(user_id);
CREATE INDEX IF NOT EXISTS favoritos_est_idx  ON public.favoritos(estabelecimento_id);
