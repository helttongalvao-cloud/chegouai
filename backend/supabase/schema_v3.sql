-- =============================================
-- CHEGOU AÍ — FEATURE: LEAFLET GPS TRACKING
-- Execute no SQL Editor do Supabase
-- =============================================

-- Adicionar coordenadas geográficas na tabela do Motoboy
ALTER TABLE public.motoboys
  ADD COLUMN IF NOT EXISTS lat DECIMAL(10,8),
  ADD COLUMN IF NOT EXISTS lng DECIMAL(11,8);

-- Fazer com que os pedidos retornem o latitude/longitude do motoboy associado
-- (O relacionamento já existe, não precisamos alterar a tabela de pedidos)
