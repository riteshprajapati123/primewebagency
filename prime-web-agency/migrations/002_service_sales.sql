-- Additive service sale configuration. Existing services retain their price;
-- that existing price is the original price used by the sale calculator.
BEGIN;

ALTER TABLE public.services
    ADD COLUMN IF NOT EXISTS sale_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20) NOT NULL DEFAULT 'percentage',
    ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS offer_badge_text VARCHAR(40),
    ADD COLUMN IF NOT EXISTS sale_start_date DATE,
    ADD COLUMN IF NOT EXISTS sale_end_date DATE;

DO $$ BEGIN
    ALTER TABLE public.services ADD CONSTRAINT services_discount_type_check
        CHECK (discount_type IN ('percentage', 'fixed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.services ADD CONSTRAINT services_discount_value_check
        CHECK (discount_value >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.services ADD CONSTRAINT services_discount_limit_check
        CHECK (discount_type <> 'percentage' OR discount_value < 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.services ADD CONSTRAINT services_sale_dates_check
        CHECK (sale_start_date IS NULL OR sale_end_date IS NULL OR sale_end_date >= sale_start_date);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
