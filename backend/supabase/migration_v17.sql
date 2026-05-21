-- v17: FCM token para push nativo Android (APK via Capacitor)
ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS fcm_token TEXT;
