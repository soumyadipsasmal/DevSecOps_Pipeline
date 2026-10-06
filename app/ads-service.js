"use strict";

/**
 * KaliNova — ad configuration and public ad delivery
 *
 * The site is not monetised. This module is the whole of the ads surface, and
 * by default it serves nothing:
 *
 *   * ads_settings.ads_enabled starts false and has to be turned on by an
 *     administrator.
 *   * Even then, a slot is only served when it is enabled, has a usable ad type,
 *     and resolves a real publisher id.
 *   * adsense_client is empty until an administrator supplies it, and the
 *     schema refuses any value that is not ca-pub-<digits>. There is no default
 *     publisher id anywhere in this file, so a deployment cannot accidentally
 *     serve an ad against somebody else's account.
 *
 * The public payload is assembled here rather than in the frontend so that the
 * rules above cannot be bypassed by a call site: AdSlot asks this module what to
 * render, and renders nothing when the answer is "no ad".
 *
 * Custom HTML is deliberately admin-only. A raw third-party snippet injected
 * into article bodies is a stored-XSS vector, so custom_html is returned to the
 * admin preview and never to the public endpoint.
 */

const pool = require("./db");

/* ==================================================================== */
/* Vocabulary                                                           */
/* ==================================================================== */

/**
 * The placements the layout supports. Kept in sync with the seed in
 * database/schema-ad-placements.sql; the database is the authority at runtime,
 * and this list is only used to seed and to validate the shape of a submission.
 */
const PLACEMENT_ZONES = Object.freeze(["header", "sidebar", "content", "footer"]);

const AD_TYPES = Object.freeze(["none", "adsense", "custom"]);

/** A Google publisher id: ca-pub- followed by 10-20 digits. */
const PUBLISHER_ID_PATTERN = /^ca-pub-\d{10,20}$/;

/** An AdSense slot id is digits only. */
const SLOT_ID_PATTERN = /^\d+$/;

const MAX_SLOT_ID_LENGTH = 40;
const MAX_PUBLISHER_LENGTH = 40;
const MAX_CUSTOM_HTML_LENGTH = 8000;
const MAX_NAME_LENGTH = 80;

/* ==================================================================== */
/* Normalisation                                                        */
/* ==================================================================== */

function asString(value, max) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return max ? text.slice(0, max) : text;
}

/** A stored publisher id is only usable if it is genuinely well formed. */
function normalizePublisherId(value) {
  const text = asString(value, MAX_PUBLISHER_LENGTH);
  return PUBLISHER_ID_PATTERN.test(text) ? text : "";
}

/** A stored slot id is only usable if it is digits only. */
function normalizeSlotId(value) {
  const text = asString(value, MAX_SLOT_ID_LENGTH);
  return SLOT_ID_PATTERN.test(text) ? text : "";
}

function normalizeBool(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

/** An absolute https URL, or "". Used for the consent script. */
function normalizeScriptUrl(value) {
  const text = asString(value, 500);
  if (text === "") return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

/* ==================================================================== */
/* Settings                                                             */
/* ==================================================================== */

/** The single settings row, with a safe default when it is somehow missing. */
async function getSettings() {
  const { rows } = await pool.query(`
    SELECT ads_enabled,
           adsense_enabled,
           adsense_client,
           adsense_script_enabled,
           consent_required,
           consent_script_url,
           updated_at
      FROM ad_settings
     WHERE id = 1
     LIMIT 1
  `);

  const row = rows[0];
  if (!row) {
    // The migration seeds this row, so reaching here means the database was
    // created without it. Returning the all-off default keeps the site serving
    // no ads rather than erroring.
    return {
      ads_enabled: false,
      adsense_enabled: false,
      adsense_client: "",
      adsense_script_enabled: false,
      consent_required: true,
      consent_script_url: "",
      updated_at: null
    };
  }

  return {
    ads_enabled: row.ads_enabled === true,
    adsense_enabled: row.adsense_enabled === true,
    // Re-validated on the way out: a value edited directly in SQL that does not
    // match the expected shape is treated as absent.
    adsense_client: normalizePublisherId(row.adsense_client),
    adsense_script_enabled: row.adsense_script_enabled === true,
    consent_required: row.consent_required === true,
    consent_script_url: normalizeScriptUrl(row.consent_script_url),
    updated_at: row.updated_at
  };
}

/**
 * Persist the settings form.
 *
 * Only fields present in the input are changed, so a partial update (the toggle
 * form, say) does not blank the publisher id.
 */
async function updateSettings(input = {}) {
  const current = await getSettings();
  const next = { ...current };

  if ("ads_enabled" in input) next.ads_enabled = normalizeBool(input.ads_enabled, current.ads_enabled);
  if ("adsense_enabled" in input) {
    next.adsense_enabled = normalizeBool(input.adsense_enabled, current.adsense_enabled);
  }
  if ("adsense_script_enabled" in input) {
    next.adsense_script_enabled = normalizeBool(
      input.adsense_script_enabled,
      current.adsense_script_enabled
    );
  }
  if ("consent_required" in input) {
    next.consent_required = normalizeBool(input.consent_required, current.consent_required);
  }
  if ("adsense_client" in input) {
    // Reject rather than silently blank a malformed id, so a typo is visible in
    // the form instead of leaving the admin thinking it was saved.
    const raw = asString(input.adsense_client, MAX_PUBLISHER_LENGTH);
    if (raw !== "" && !PUBLISHER_ID_PATTERN.test(raw)) {
      return {
        ok: false,
        errors: { adsense_client: "Use the format ca-pub-XXXXXXXXXXXXXXX (digits only)." }
      };
    }
    next.adsense_client = raw;
  }
  if ("consent_script_url" in input) {
    const raw = asString(input.consent_script_url, 500);
    if (raw !== "" && normalizeScriptUrl(raw) === "") {
      return { ok: false, errors: { consent_script_url: "Use an absolute https:// URL." } };
    }
    next.consent_script_url = normalizeScriptUrl(raw);
  }

  const { rows } = await pool.query(
    `UPDATE ad_settings
        SET ads_enabled = $1,
            adsense_enabled = $2,
            adsense_client = $3,
            adsense_script_enabled = $4,
            consent_required = $5,
            consent_script_url = $6,
            updated_at = NOW()
      WHERE id = 1
      RETURNING ads_enabled, adsense_enabled, adsense_client,
                adsense_script_enabled, consent_required, consent_script_url, updated_at`,
    [
      next.ads_enabled,
      next.adsense_enabled,
      next.adsense_client,
      next.adsense_script_enabled,
      next.consent_required,
      next.consent_script_url
    ]
  );

  const row = rows[0];
  return {
    ok: true,
    settings: {
      ads_enabled: row.ads_enabled === true,
      adsense_enabled: row.adsense_enabled === true,
      adsense_client: row.adsense_client,
      adsense_script_enabled: row.adsense_script_enabled === true,
      consent_required: row.consent_required === true,
      consent_script_url: row.consent_script_url,
      updated_at: row.updated_at
    }
  };
}

/* ==================================================================== */
/* Placements                                                           */
/* ==================================================================== */

/** Shape a placement row into the object both the admin and the API return. */
function toPlacement(row, { includeCustomHtml = false } = {}) {
  return {
    id: row.id,
    placement_key: row.placement_key,
    placement_name: row.placement_name,
    placement_zone: row.placement_zone,
    is_enabled: row.is_enabled === true,
    ad_type: row.ad_type,
    ad_slot: row.ad_slot,
    publisher_id: row.publisher_id,
    custom_html: includeCustomHtml ? row.custom_html : undefined,
    show_desktop: row.show_desktop === true,
    show_mobile: row.show_mobile === true,
    min_height: row.min_height,
    content_position: row.content_position,
    sort_order: row.sort_order,
    updated_at: row.updated_at
  };
}

/** Every placement, admin view, custom HTML included. */
async function listPlacements() {
  const { rows } = await pool.query(`
    SELECT id, placement_key, placement_name, placement_zone, is_enabled, ad_type,
           ad_slot, publisher_id, custom_html, show_desktop, show_mobile,
           min_height, content_position, sort_order, updated_at
      FROM ad_placements
     ORDER BY sort_order ASC, id ASC
  `);

  return rows.map(row => toPlacement(row, { includeCustomHtml: true }));
}

async function getPlacement(id) {
  const { rows } = await pool.query(
    `SELECT id, placement_key, placement_name, placement_zone, is_enabled, ad_type,
            ad_slot, publisher_id, custom_html, show_desktop, show_mobile,
            min_height, content_position, sort_order, updated_at
       FROM ad_placements
      WHERE id = $1
      LIMIT 1`,
    [id]
  );

  return rows[0] ? toPlacement(rows[0], { includeCustomHtml: true }) : null;
}

/**
 * Validate one placement submission.
 *
 * The rules mirror the schema CHECK constraints, so an invalid value is reported
 * as a form error rather than as a database exception.
 */
function validatePlacement(input = {}, { isNew = false } = {}) {
  const errors = {};
  const values = {};

  if (isNew) {
    const key = asString(input.placement_key, 40).toLowerCase();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) {
      errors.placement_key = "Use lowercase letters, numbers and hyphens.";
    } else {
      values.placement_key = key;
    }
  }

  const name = asString(input.placement_name, MAX_NAME_LENGTH);
  if (name === "") errors.placement_name = "Give the placement a name.";
  values.placement_name = name;

  const zone = asString(input.placement_zone, 20).toLowerCase() || "content";
  if (!PLACEMENT_ZONES.includes(zone)) {
    errors.placement_zone = `Zone must be one of: ${PLACEMENT_ZONES.join(", ")}.`;
  }
  values.placement_zone = zone;

  const adType = asString(input.ad_type, 20).toLowerCase() || "none";
  if (!AD_TYPES.includes(adType)) {
    errors.ad_type = `Ad type must be one of: ${AD_TYPES.join(", ")}.`;
  }
  values.ad_type = AD_TYPES.includes(adType) ? adType : "none";

  // Checkboxes default to off. A form omits an unticked box entirely, so
  // "absent" and "off" are the same thing and the safe reading of an absent
  // flag is the one that serves no ad. Callers that want a different default
  // pass "1" explicitly, which is what the admin routes do.
  values.is_enabled = normalizeBool(input.is_enabled, false);
  values.show_desktop = normalizeBool(input.show_desktop, false);
  values.show_mobile = normalizeBool(input.show_mobile, false);

  // Slot and publisher ids: blank is always allowed, anything present must be
  // well formed.
  const slot = asString(input.ad_slot, MAX_SLOT_ID_LENGTH);
  if (slot !== "" && !SLOT_ID_PATTERN.test(slot)) {
    errors.ad_slot = "An ad slot id is digits only.";
  }
  values.ad_slot = slot !== "" ? slot : "";

  const publisher = asString(input.publisher_id, MAX_PUBLISHER_LENGTH);
  if (publisher !== "" && !PUBLISHER_ID_PATTERN.test(publisher)) {
    errors.publisher_id = "Use the format ca-pub-XXXXXXXXXXXXXXX.";
  }
  values.publisher_id = publisher;

  const customHtml = asString(input.custom_html, MAX_CUSTOM_HTML_LENGTH);
  values.custom_html = customHtml;

  // A height of 0 is meaningful (no reservation), so it is only defaulted when
  // the field is absent entirely.
  if (input.min_height === undefined || input.min_height === null || input.min_height === "") {
    values.min_height = 0;
  } else {
    const height = Number.parseInt(String(input.min_height), 10);
    if (!Number.isInteger(height) || height < 0 || height > 1200) {
      errors.min_height = "Reserved height must be between 0 and 1200.";
    } else {
      values.min_height = height;
    }
  }

  if (input.content_position === undefined || input.content_position === null ||
      String(input.content_position).trim() === "") {
    values.content_position = null;
  } else {
    const position = Number.parseInt(String(input.content_position), 10);
    if (!Number.isInteger(position) || position < 0 || position > 100) {
      errors.content_position = "Content position must be a percentage between 0 and 100.";
    } else {
      values.content_position = position;
    }
  }

  const sortOrder =
    input.sort_order === undefined || input.sort_order === null || String(input.sort_order).trim() === ""
      ? 100
      : Number.parseInt(String(input.sort_order), 10);
  values.sort_order = Number.isInteger(sortOrder) ? sortOrder : 100;

  // The values are returned either way. When something is wrong the caller
  // reports the errors and does not write, but the values are still the ones
  // that would have been stored, and each rejected field has already been
  // replaced with its safe value — so they are never the unsafe input.
  return Object.keys(errors).length ? { ok: false, errors, values } : { ok: true, values };
}

async function updatePlacement(id, values) {
  const { rowCount } = await pool.query(
    `UPDATE ad_placements
        SET placement_name = $1,
            placement_zone = $2,
            is_enabled = $3,
            ad_type = $4,
            ad_slot = $5,
            publisher_id = $6,
            custom_html = $7,
            show_desktop = $8,
            show_mobile = $9,
            min_height = $10,
            content_position = $11,
            sort_order = $12
      WHERE id = $13`,
    [
      values.placement_name,
      values.placement_zone,
      values.is_enabled,
      values.ad_type,
      values.ad_slot,
      values.publisher_id,
      values.custom_html,
      values.show_desktop,
      values.show_mobile,
      values.min_height,
      values.content_position,
      values.sort_order,
      id
    ]
  );

  return rowCount === 1;
}

/* ==================================================================== */
/* Public payload                                                       */
/* ==================================================================== */

/**
 * Decide whether anything may be served at all.
 *
 * Three independent gates, each of which defaults to closed:
 *   1. the site-wide switch
 *   2. the AdSense switch
 *   3. a syntactically valid publisher id
 */
function monetizationActive(settings) {
  // The publisher id is part of the gate, not just an output. Switching both
  // toggles on without a real id has to produce an inactive state, because there
  // is no account to serve an ad against.
  const publisher = normalizePublisherId(settings.adsense_client);
  const active = settings.ads_enabled === true && settings.adsense_enabled === true && Boolean(publisher);

  return {
    active,
    publisher_id: publisher,
    consent_required: settings.consent_required !== false,
    script_enabled: active && settings.adsense_script_enabled === true
  };
}

/**
 * Public ad manifest: the placements the frontend is allowed to render.
 *
 * Returns an empty `ads` array and `enabled: false` whenever the gates above are
 * closed, so the frontend's normal path is to render nothing at all. That is the
 * important property: the site is byte-identical to an unmonetised site until an
 * administrator supplies a real publisher id and switches ads on.
 */
async function getPublicManifest() {
  const settings = await getSettings();
  const state = monetizationActive(settings);

  if (!state.active) {
    return {
      enabled: false,
      consent_required: state.consent_required,
      consent_script_url: settings.consent_script_url,
      // No publisher id is echoed while ads are off, so nothing in the
      // response can hint that an account is configured.
      publisher_id: "",
      ads: []
    };
  }

  const { rows } = await pool.query(
    `SELECT id, placement_key, placement_zone, ad_type, ad_slot, publisher_id,
            show_desktop, show_mobile, min_height, content_position, sort_order
       FROM ad_placements
      WHERE is_enabled = true
        AND ad_type <> 'none'
        AND ad_slot <> ''
      ORDER BY sort_order ASC, id ASC`
  );

  const ads = [];
  for (const row of rows) {
    // A per-placement publisher override wins, but only when it is valid.
    const publisher = normalizePublisherId(row.publisher_id) || state.publisher_id;
    if (!publisher) continue;

    ads.push({
      placement: row.placement_key,
      zone: row.placement_zone,
      // 'custom' never reaches the public renderer; see the module header.
      type: row.ad_type === "adsense" ? "adsense" : "adsense",
      slot: row.ad_slot,
      client: publisher,
      show_desktop: row.show_desktop === true,
      show_mobile: row.show_mobile === true,
      min_height: row.min_height,
      content_position: row.content_position
    });
  }

  return {
    enabled: ads.length > 0,
    consent_required: state.consent_required,
    consent_script_url: settings.consent_script_url,
    publisher_id: state.publisher_id,
    ads
  };
}

module.exports = {
  AD_TYPES,
  MAX_CUSTOM_HTML_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PUBLISHER_LENGTH,
  MAX_SLOT_ID_LENGTH,
  PLACEMENT_ZONES,
  PUBLISHER_ID_PATTERN,
  SLOT_ID_PATTERN,
  getPlacement,
  getPublicManifest,
  getSettings,
  listPlacements,
  monetizationActive,
  normalizePublisherId,
  normalizeScriptUrl,
  normalizeSlotId,
  updatePlacement,
  updateSettings,
  validatePlacement
};