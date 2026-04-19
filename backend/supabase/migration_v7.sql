-- =========================================================
-- Migration v7 — Pausar loja + Complementos/Adicionais
-- Rodar no Supabase SQL Editor
-- =========================================================

-- 1. Pausar loja temporariamente
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS pausado BOOLEAN DEFAULT false;

-- 2. Complementos selecionados no item do pedido
ALTER TABLE itens_pedido ADD COLUMN IF NOT EXISTS complementos JSONB;

-- 3. Grupos de complemento por produto
CREATE TABLE IF NOT EXISTS grupos_complementos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id   UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  nome         TEXT NOT NULL,
  obrigatorio  BOOLEAN DEFAULT false,
  max_escolhas INT DEFAULT 1,
  ordem        INT DEFAULT 0,
  criado_em    TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Opções dentro de cada grupo
CREATE TABLE IF NOT EXISTS complementos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo_id         UUID NOT NULL REFERENCES grupos_complementos(id) ON DELETE CASCADE,
  nome             TEXT NOT NULL,
  preco_adicional  DECIMAL(10,2) DEFAULT 0,
  disponivel       BOOLEAN DEFAULT true,
  ordem            INT DEFAULT 0
);

-- 5. RLS — backend (service_role) tem acesso total
ALTER TABLE grupos_complementos ENABLE ROW LEVEL SECURITY;
ALTER TABLE complementos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_grupos" ON grupos_complementos;
DROP POLICY IF EXISTS "service_role_complementos" ON complementos;
DROP POLICY IF EXISTS "public_read_grupos" ON grupos_complementos;
DROP POLICY IF EXISTS "public_read_complementos" ON complementos;

CREATE POLICY "service_role_grupos"    ON grupos_complementos TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_complementos" ON complementos    TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "public_read_grupos"     ON grupos_complementos FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "public_read_complementos" ON complementos     FOR SELECT TO anon, authenticated USING (true);
