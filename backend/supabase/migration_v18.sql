-- v18: FCM token do motoboy próprio (sem login) por estabelecimento
ALTER TABLE public.estabelecimentos
  ADD COLUMN IF NOT EXISTS motoboy_fcm_token TEXT;
