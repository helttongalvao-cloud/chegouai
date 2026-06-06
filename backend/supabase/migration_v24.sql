-- Migration v24 — Telegram para lojistas
ALTER TABLE public.estabelecimentos ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT DEFAULT NULL;
