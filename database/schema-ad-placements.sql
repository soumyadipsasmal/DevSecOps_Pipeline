-- ---------------------------------------------------------------------------
-- Ad placements and monetization settings.
--
-- KaliNova is not monetised yet. This migration creates the storage an
-- administrator needs to configure ads when that happens, and seeds every
-- placement DISABLED with an empty publisher ID, so nothing renders and no
-- third-party script is requested until an administrator supplies real values.
--
-- Two tables:
--   ad_settings     one row: site-wide switch plus the AdSense identifiers
--   ad_placements   one row per position in the layout, editable in the admin
--
-- Design notes:
--   * No publisher ID is hardcoded anywhere. The seeded row stores an empty
--     string, and the public API refuses to emit an ad until an administrator
--     has saved a syntactically valid `ca-pub-XXXXXXXXXXXXXXX` value.
--   * The placement key is the stable identifier the frontend asks for
--     (AdSlot "sidebar-top" etc.), so renaming a display label never breaks a
--     call site.
--   * custom_html exists for networks that need a snippet of their own. It is
--     never rendered on the public site without an explicit opt-in below, and
--     is served only to the admin preview.
--
-- Safe by construction:
--   * additive only, new tables, no existing table is touched
--   * every statement is guarded, so re-running is a no-op
--   * the seed uses ON CONFLICT DO NOTHING, so an administrator's edits survive
-- ---------------------------------------------------------------------------

-- --- ad_settings ------------------------------------------------------------
-- Singleton: ads_enabled is the master switch, adsense_enabled gates the Google
-- network specifically. Both must be true before any public ad is served.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'ad_settings'
    ) THEN
        CREATE TABLE ad_settings (
            id                  SMALLINT PRIMARY KEY DEFAULT 1,

            -- Master switch. Nothing renders anywhere while this is false,
            -- regardless of what any placement says.
            ads_enabled         BOOLEAN NOT NULL DEFAULT FALSE,

            -- Per-network switches. adsense_enabled only takes effect once
            -- ads_enabled is also true.
            adsense_enabled     BOOLEAN NOT NULL DEFAULT FALSE,

            -- Google AdSense publisher id, stored as the site owner types it
            -- (ca-pub-XXXXXXXXXXXXXXX). Empty until an administrator supplies it.
            adsense_client      TEXT NOT NULL DEFAULT '',

            -- Loads the adsbygoogle.js script once per page. Kept separate from
            -- adsense_enabled so the script can be staged before any slot is
            -- switched on. Still requires a valid adsense_client.
            adsense_script_enabled BOOLEAN NOT NULL DEFAULT FALSE,

            -- Consent gate. While consent_mode is false the frontend refuses to
            -- request any third-party ad resource. Turning this on is the last
            -- step before monetisation, not the first.
            consent_required    BOOLEAN NOT NULL DEFAULT TRUE,

            -- Optional CMP/consent provider script URL. Empty until one is chosen.
            consent_script_url  TEXT NOT NULL DEFAULT '',

            updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

            -- A single row table: enforce it in the schema rather than in code.
            CONSTRAINT ad_settings_singleton CHECK (id = 1),
            CONSTRAINT ad_settings_client_format CHECK (
                adsense_client = ''
                OR adsense_client ~ '^ca-pub-[0-9]{10,20}$'
            )
        );
    END IF;
END $$;

-- Exactly one settings row, present from the first migration run.
INSERT INTO ad_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- --- ad_placements ----------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'ad_placements'
    ) THEN
        CREATE TABLE ad_placements (
            id                SERIAL PRIMARY KEY,

            -- Stable call-site key, e.g. 'sidebar-top'. The frontend requests
            -- exactly this value, so it must not change once shipped.
            placement_key     VARCHAR(40) NOT NULL UNIQUE,

            -- Human label shown in the admin table. Free to be reworded.
            placement_name    VARCHAR(80) NOT NULL,

            -- Where the slot sits, used only to group the admin table.
            placement_zone    VARCHAR(20) NOT NULL DEFAULT 'content',

            -- Every placement starts disabled. Monetisation is opt-in per slot.
            is_enabled        BOOLEAN NOT NULL DEFAULT FALSE,

            -- 'adsense' | 'custom' | 'none'
            -- 'none' means the slot exists in the layout but is deliberately
            -- empty, which is the correct value for a placement that has no ad.
            ad_type           VARCHAR(20) NOT NULL DEFAULT 'none',

            -- Ad slot id from the ad network (XXXXXXXXXX for AdSense). Empty
            -- until supplied. Must be digits only, so nothing can be injected
            -- through the slot id into the rendered <ins> element.
            ad_slot           VARCHAR(40) NOT NULL DEFAULT '',

            -- Optional override of the site-wide publisher id for this slot.
            -- Empty means "inherit from ad_settings.adsense_client".
            publisher_id      VARCHAR(40) NOT NULL DEFAULT '',

            -- Raw snippet for networks that are not AdSense. Admin-only: the
            -- public renderer never emits this, because an unescaped third-party
            -- snippet in article HTML is an injection risk.
            custom_html       TEXT NOT NULL DEFAULT '',

            -- Responsive display flags. Both default to true so a new placement
            -- is not invisible on phones.
            show_desktop      BOOLEAN NOT NULL DEFAULT TRUE,
            show_mobile       BOOLEAN NOT NULL DEFAULT TRUE,

            -- Reserved height in CSS pixels, reserved before the ad loads so the
            -- slot cannot shift the article text around it. 0 means "no
            -- reservation", which is correct for a horizontal banner only if the
            -- reader is on a wide screen.
            min_height        SMALLINT NOT NULL DEFAULT 0,

            -- Article placements only: how far down the body the slot may appear,
            -- as a percentage. NULL means "no in-content slots on this placement".
            -- The frontend never splits a paragraph to make room for an ad.
            content_position  SMALLINT,

            sort_order        SMALLINT NOT NULL DEFAULT 0,

            created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT ad_placements_key_format CHECK (placement_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
            CONSTRAINT ad_placements_type_allowed CHECK (ad_type IN ('adsense', 'custom', 'none')),
            CONSTRAINT ad_placements_zone_allowed CHECK (
                placement_zone IN ('header', 'sidebar', 'content', 'footer')
            ),
            CONSTRAINT ad_placements_slot_digits CHECK (ad_slot = '' OR ad_slot ~ '^[0-9]+$'),
            CONSTRAINT ad_placements_publisher_format CHECK (
                publisher_id = '' OR publisher_id ~ '^ca-pub-[0-9]{10,20}$'
            ),
            CONSTRAINT ad_placements_height_sane CHECK (min_height BETWEEN 0 AND 1200),
            CONSTRAINT ad_placements_position_sane CHECK (
                content_position IS NULL OR content_position BETWEEN 0 AND 100
            )
        );
    END IF;
END $$;

-- --- seed the placements the layout already has room for --------------------
-- All disabled, ad_type 'none', no slot id. This creates the vocabulary the
-- frontend and the admin UI share without switching anything on.
INSERT INTO ad_placements
    (placement_key, placement_name, placement_zone, ad_type, sort_order)
VALUES
    ('header-top',      'Header / Top Banner',       'header',  'none', 10),
    ('below-nav',       'Below Navigation',          'header',  'none', 20),
    ('sidebar-top',     'Sidebar Top',               'sidebar', 'none', 30),
    ('sidebar-middle',  'Sidebar Middle',            'sidebar', 'none', 40),
    ('sidebar-bottom',  'Sidebar Bottom',            'sidebar', 'none', 50),
    ('before-article',  'Before Article',            'content', 'none', 60),
    ('in-article',      'Inside Article',            'content', 'none', 70),
    ('after-article',   'After Article',             'content', 'none', 80),
    ('footer',          'Footer',                    'footer',  'none', 90)
ON CONFLICT (placement_key) DO NOTHING;

-- --- keep updated_at honest --------------------------------------------------
-- Mirrors articles_touch_updated_at from schema-article-cms.sql: any UPDATE
-- refreshes the timestamp, so the admin table can show a truthful "last change".
CREATE OR REPLACE FUNCTION kalinova_touch_ad_placements_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ad_placements_touch_updated_at ON ad_placements;

CREATE TRIGGER ad_placements_touch_updated_at
    BEFORE UPDATE ON ad_placements
    FOR EACH ROW
    EXECUTE FUNCTION kalinova_touch_ad_placements_updated_at();

-- --- indexes -----------------------------------------------------------------
-- The public renderer asks for "the enabled placements", so index that filter.
CREATE INDEX IF NOT EXISTS idx_ad_placements_enabled ON ad_placements (is_enabled) WHERE is_enabled;
-- The admin table lists by zone then order.
CREATE INDEX IF NOT EXISTS idx_ad_placements_zone_order ON ad_placements (placement_zone, sort_order);