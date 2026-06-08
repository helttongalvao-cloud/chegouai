-- v27: campanhas de desconto automáticas por estabelecimento
CREATE TABLE IF NOT EXISTS public.campanhas_estabelecimento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estabelecimento_id UUID NOT NULL REFERENCES public.estabelecimentos(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('percentual', 'fixo', 'frete_gratis')),
  valor NUMERIC(10,2) DEFAULT 0,
  valor_minimo NUMERIC(10,2) DEFAULT 0,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.campanhas_estabelecimento ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lojista_vê_próprias_campanhas" ON public.campanhas_estabelecimento
  FOR ALL USING (
    estabelecimento_id IN (SELECT id FROM public.estabelecimentos WHERE user_id = auth.uid())
  );
