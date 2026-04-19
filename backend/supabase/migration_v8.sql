-- =========================================================
-- Migration v8 — Corrige permissão na tabela motoboys_proprios
-- Rodar no Supabase SQL Editor
-- =========================================================

-- Garante que service_role pode ler/escrever a tabela
GRANT ALL ON motoboys_proprios TO service_role;
GRANT SELECT ON motoboys_proprios TO anon, authenticated;

-- Habilita RLS e cria política para service_role (caso não exista)
ALTER TABLE motoboys_proprios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_motoboys_proprios" ON motoboys_proprios;
DROP POLICY IF EXISTS "public_read_motoboys_proprios" ON motoboys_proprios;

CREATE POLICY "service_role_motoboys_proprios"
  ON motoboys_proprios TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "public_read_motoboys_proprios"
  ON motoboys_proprios FOR SELECT TO anon, authenticated USING (true);
