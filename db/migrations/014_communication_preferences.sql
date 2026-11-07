-- Additive migration; apply to stage first. Existing consent is preserved, never backdated.
BEGIN;
ALTER TABLE public.users
 ADD COLUMN IF NOT EXISTS email_consent_updated_at timestamptz,
 ADD COLUMN IF NOT EXISTS email_consent_source text,
 ADD COLUMN IF NOT EXISTS email_consent_version text,
 ADD COLUMN IF NOT EXISTS email_offer_count smallint NOT NULL DEFAULT 0 CHECK (email_offer_count BETWEEN 0 AND 3),
 ADD COLUMN IF NOT EXISTS email_offer_active smallint CHECK (email_offer_active BETWEEN 1 AND 3),
 ADD COLUMN IF NOT EXISTS email_offer_next_at timestamptz,
 ADD COLUMN IF NOT EXISTS email_offer_shown_at timestamptz,
 ADD COLUMN IF NOT EXISTS email_offer_declined_at timestamptz,
 ADD COLUMN IF NOT EXISTS telegram_channel_invited_at timestamptz;
CREATE TABLE IF NOT EXISTS public.email_consent_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 accepted boolean NOT NULL,
 happened_at timestamptz NOT NULL DEFAULT now(),
 source text NOT NULL,
 version text
);
CREATE INDEX IF NOT EXISTS email_consent_events_user_idx ON public.email_consent_events(user_id,happened_at);
ALTER TABLE public.email_consent_events ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.record_email_consent_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean; source_name text;
BEGIN
 IF TG_OP = 'INSERT' THEN changed := NEW.email_letters_accepted IS TRUE;
 ELSE changed := NEW.email_letters_accepted IS DISTINCT FROM OLD.email_letters_accepted
   OR NEW.email_unsubscribed_at IS DISTINCT FROM OLD.email_unsubscribed_at
   OR NEW.email_consent_updated_at IS DISTINCT FROM OLD.email_consent_updated_at;
 END IF;
 IF changed THEN
  source_name := COALESCE(NEW.email_consent_source,'legacy_or_delivery_event');
  IF TG_OP = 'UPDATE' THEN
   IF NEW.email_consent_updated_at IS NOT DISTINCT FROM OLD.email_consent_updated_at THEN source_name := 'legacy_or_delivery_event'; END IF;
  END IF;
  INSERT INTO public.email_consent_events(user_id,accepted,happened_at,source,version)
   VALUES(NEW.id,NEW.email_letters_accepted IS TRUE AND NEW.email_unsubscribed_at IS NULL,
    CASE WHEN source_name='legacy_or_delivery_event' THEN now() ELSE COALESCE(NEW.email_consent_updated_at,now()) END,
    source_name,CASE WHEN source_name='legacy_or_delivery_event' THEN NULL ELSE NEW.email_consent_version END);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS users_record_email_consent ON public.users;
CREATE TRIGGER users_record_email_consent AFTER INSERT OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.record_email_consent_event();
DO $$ DECLARE owner_name text; BEGIN
 SELECT tableowner INTO owner_name FROM pg_tables WHERE schemaname='public' AND tablename='users';
 IF owner_name IS NOT NULL THEN EXECUTE format('ALTER TABLE public.email_consent_events OWNER TO %I',owner_name); END IF;
END $$;
COMMIT;
