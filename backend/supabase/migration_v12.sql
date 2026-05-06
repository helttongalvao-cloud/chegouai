-- =========================================================
-- Migration v12 — Avaliação de motoboy
-- nota_motoboy: nota de 1-5 que o cliente dá ao motoboy após entrega
-- Rodar no Supabase SQL Editor
-- =========================================================

ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS nota_motoboy INTEGER CHECK (nota_motoboy BETWEEN 1 AND 5);
