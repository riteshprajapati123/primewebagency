-- Placement-wide switches for the advertisement system.
BEGIN;
CREATE TABLE IF NOT EXISTS public.advertisement_placements (
  placement VARCHAR(32) PRIMARY KEY CHECK (placement IN ('top_strip','below_hero','above_footer','promo_section')),
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.advertisement_placements(placement) VALUES
 ('top_strip'),('below_hero'),('above_footer'),('promo_section')
ON CONFLICT (placement) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_advertisement_placements_enabled ON public.advertisement_placements(is_enabled);
COMMIT;
