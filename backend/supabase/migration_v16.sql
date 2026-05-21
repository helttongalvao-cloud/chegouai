-- v16: flag para forçar renovação de subscription push quando expirar (erro 410)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS push_needs_renewal BOOLEAN DEFAULT false;
