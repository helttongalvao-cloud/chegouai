-- v15: unidade de venda por produto (un = unidade, kg = por quilograma)
ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS unidade TEXT NOT NULL DEFAULT 'un'
    CHECK (unidade IN ('un', 'kg'));
