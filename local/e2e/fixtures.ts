import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { WEB, sql } from "./helpers";

/**
 * Fixtures shared by the M10 and M19 specs (dev database only): an owner's roles and a live two-court
 * ground at ৳2,000/h flat with a 25% advance, written straight into the database (the M09 spec covers
 * the real listing flow), and booking tomorrow's first free hour in the widget.
 */
/** The owner's roles and a live ground with two courts, open around the clock (dev database only). */
export function liveGround(ownerId: string, run: string) {
  const g = randomUUID();
  const courts = [randomUUID(), randomUUID()];
  const slug = `e2e-arena-${run}`;
  const court = (id: string, i: number) =>
    `INSERT INTO courts (id, ground_id, name, sport_ids, surface_id, status, sort) VALUES ('${id}', '${g}', 'Court ${i + 1}', ARRAY[(SELECT id FROM sports WHERE key = 'football')], (SELECT id FROM surfaces WHERE key = 'artificial_turf'), 'active', ${i});
     INSERT INTO court_hours (id, court_id, dow, is_closed, open_time, close_time) SELECT gen_random_uuid(), '${id}', d, false, '00:00', '24:00' FROM generate_series(0, 6) d;`;
  sql(`
    UPDATE user_roles SET status = 'active', activated_at = now() WHERE user_id = '${ownerId}' AND role = 'member';
    INSERT INTO user_roles (id, user_id, role, status, activated_at) SELECT gen_random_uuid(), '${ownerId}', 'member', 'active', now() WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = '${ownerId}' AND role = 'member');
    INSERT INTO user_roles (id, user_id, role, status, activated_at) VALUES (gen_random_uuid(), '${ownerId}', 'ground_owner', 'active', now());
    UPDATE users SET kyc_status = 'verified', authz_version = authz_version + 1 WHERE id = '${ownerId}';
    INSERT INTO grounds (id, owner_id, name, slug, area_id, address_line, lat, lng, status) VALUES ('${g}', '${ownerId}', 'E2E Arena ${run}', '${slug}', (SELECT id FROM areas WHERE key = 'dhanmondi'), 'Road 8A, Dhanmondi', 23.7465, 90.376, 'draft');
    ${courts.map(court).join("\n")}
    UPDATE grounds SET status = 'live', live_version = 1, first_live_at = now(), live_snapshot = jsonb_build_object(
      'version', 1, 'name', 'E2E Arena ${run}', 'areaId', (SELECT id FROM areas WHERE key = 'dhanmondi'), 'addressLine', 'Road 8A, Dhanmondi', 'lat', 23.7465, 'lng', 90.376,
      'isIndoor', false, 'description', null, 'rulesText', null, 'facilityIds', '[]'::jsonb, 'bookingCutoffMin', 0, 'requiresOfficial', '[]'::jsonb, 'photos', '[]'::jsonb,
      'courts', (SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'sportIds', to_jsonb(c.sport_ids), 'surfaceId', c.surface_id, 'sizeText', null, 'capacityText', null, 'combinableGroup', null, 'sort', c.sort) ORDER BY c.sort) FROM courts c WHERE c.ground_id = '${g}'))
      WHERE id = '${g}';
    INSERT INTO pricing_rules (id, ground_id, version, status, base_price_poisha, court_base_overrides, peak_from_hour, early_to_hour, peak_pct, weekend_pct, early_pct, advance_pct, series_discount_pct, min_booking_min, full_refund_hours, half_refund_hours, checkin_grace_min, effective_from)
      VALUES (gen_random_uuid(), '${g}', 1, 'published', 200000, '{}', 17, 8, 0, 0, 0, 25, 10, 60, 24, 6, 15, now() - interval '1 day');
  `);
  return { id: g, slug, courts };
}

/** Book tomorrow's first free hour in the widget and pay the advance; returns the booking id. */
export async function bookTomorrow(page: Page, slug: string): Promise<string> {
  await page.goto(`${WEB}/venues/${slug}`);
  const widget = page.getByTestId("booking-widget");
  await expect(widget).toBeVisible();
  await widget.getByRole("tab").nth(1).click();
  await widget.getByTestId("slot-grid").locator('button:not([disabled])').first().click();
  await expect(widget.getByText("Pay ৳500 advance now")).toBeVisible();
  await widget.getByTestId("hold-and-pay").click();
  await expect(page).toHaveURL(new RegExp(`^${WEB}/pay/`));
  await page.getByRole("radio", { name: "bKash" }).check();
  await page.getByTestId("pay-button").click();
  await page.getByRole("button", { name: "Pay with bKash" }).click();
  await expect(page.getByTestId("pay-result")).toHaveAttribute("data-outcome", "paid");
  await page.getByTestId("back-to-booking").click();
  await expect(page).toHaveURL(new RegExp(`${WEB}/me/bookings/`));
  await expect(page.getByTestId("booking-status")).toHaveText("Confirmed");
  return page.url().split("/").pop()!;
}

/** Move a booking (and its active slots) to start at the current hour, so it can be checked in. */
export function startNow(bookingId: string) {
  sql(`UPDATE bookings SET start_at = date_trunc('hour', now()), end_at = date_trunc('hour', now()) + interval '1 hour' WHERE id = '${bookingId}';
       UPDATE booking_slots SET period = tstzrange(date_trunc('hour', now()), date_trunc('hour', now()) + interval '1 hour', '[)') WHERE booking_id = '${bookingId}' AND status = 'active';`);
}

/**
 * M13: the member's shop_owner role and a live sports gear shop in Dhanmondi with turf boots at
 * ৳6,500 in EU 42 (5 in stock, opened on the stock ledger), written straight into the database (the
 * M12 spec covers the real listing and review flow). Dev database only.
 */
export function liveShopWithBoots(ownerId: string, run: string) {
  const shop = randomUUID();
  const product = randomUUID();
  const variant = randomUUID();
  const slug = `e2e-boots-${run}`;
  const area = "(SELECT id FROM areas WHERE key = 'dhanmondi')";
  const type = "(SELECT id FROM item_types WHERE key = 'football_boots')";
  sql(`
    UPDATE user_roles SET status = 'active', activated_at = now() WHERE user_id = '${ownerId}' AND role = 'member';
    INSERT INTO user_roles (id, user_id, role, status, activated_at) SELECT gen_random_uuid(), '${ownerId}', 'member', 'active', now() WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = '${ownerId}' AND role = 'member');
    INSERT INTO user_roles (id, user_id, role, status, activated_at) VALUES (gen_random_uuid(), '${ownerId}', 'shop_owner', 'active', now());
    UPDATE users SET kyc_status = 'verified', authz_version = authz_version + 1 WHERE id = '${ownerId}';
    INSERT INTO shops (id, owner_id, shop_type, name, slug, area_id, address_line, status, live_version, first_live_at, low_stock_threshold, auto_hide_out_of_stock, mto_days_default, live_snapshot)
      VALUES ('${shop}', '${ownerId}', 'sports_gear', 'E2E Boot Room ${run}', 'e2e-boot-room-${run}', ${area}, '12 Elephant Road, Dhaka', 'live', 1, now(), 3, true, 5,
        jsonb_build_object('version', 1, 'name', 'E2E Boot Room ${run}', 'shopType', 'sports_gear', 'areaId', ${area}, 'addressLine', '12 Elephant Road, Dhaka', 'lat', null, 'lng', null, 'about', null));
    INSERT INTO products (id, shop_id, item_type_id, title, slug, specs, base_price_poisha, max_qty_per_order, status, live_version, first_live_at, visibility, public_title, public_item_type_id, public_price_from_poisha, public_price_to_poisha, live_snapshot)
      VALUES ('${product}', '${shop}', ${type}, 'E2E Turf Boots ${run}', '${slug}', '{"stud_type":"tf"}', 650000, 10, 'live', 1, now(), 'visible', 'E2E Turf Boots ${run}', ${type}, 650000, 650000,
        jsonb_build_object('version', 1, 'title', 'E2E Turf Boots ${run}', 'itemTypeId', ${type}, 'brand', null, 'description', null, 'specs', '{"stud_type":"tf"}'::jsonb, 'isMto', false, 'mtoDays', null,
          'maxQtyPerOrder', 10, 'importer', null, 'bstiRegNo', null, 'basePricePoisha', 650000, 'photos', '[]'::jsonb,
          'variants', jsonb_build_array(jsonb_build_object('id', '${variant}', 'attributes', '{"eu_size":"42"}'::jsonb, 'sku', null, 'pricePoisha', 650000, 'expiryDate', null, 'batchNo', null, 'sort', 0))));
    INSERT INTO product_variants (id, product_id, shop_id, attributes, on_hand, held, status, sort) VALUES ('${variant}', '${product}', '${shop}', '{"eu_size":"42"}', 5, 0, 'active', 0);
    INSERT INTO inventory_movements (id, variant_id, type, delta_on_hand, delta_held, on_hand_after, held_after, reason_code, ref_type) VALUES (gen_random_uuid(), '${variant}', 'receive', 5, 0, 5, 0, 'opening', 'manual');
  `);
  return { shop, product, variant, slug };
}

/**
 * M11: a pro's roles and a live T20 scorer profile based in Dhanmondi (dev database only; the M11
 * Postman run covers the credential, the review and the rate limits). Rates: T20 ৳2,500, T10 ৳1,500;
 * night +20%; short notice +15% under 48 h; travel ৳300 north, ৳500 south, ৳1,500 outside Dhaka.
 */
export function liveHireProfile(proId: string, run: string) {
  const profile = randomUUID();
  const card = randomUUID();
  const slug = `e2e-scorer-${run}`;
  const area = "(SELECT id FROM areas WHERE key = 'dhanmondi')";
  const role = "(SELECT id FROM hire_roles WHERE key = 'scorer')";
  const headline = `E2E league scorer ${run}`;
  sql(`
    UPDATE user_roles SET status = 'active', activated_at = now() WHERE user_id = '${proId}' AND role = 'member';
    INSERT INTO user_roles (id, user_id, role, status, activated_at) SELECT gen_random_uuid(), '${proId}', 'member', 'active', now() WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = '${proId}' AND role = 'member');
    INSERT INTO user_roles (id, user_id, role, status, activated_at) VALUES (gen_random_uuid(), '${proId}', 'pro', 'active', now());
    UPDATE users SET kyc_status = 'verified', authz_version = authz_version + 1 WHERE id = '${proId}';
    INSERT INTO hire_profiles (id, user_id, role_id, slug, headline, sport_keys, experience_level, years, base_area_id, bio, status, live_version, live_snapshot, first_live_at, status_changed_at, public_headline, public_experience_level, public_area_id, normalised_hourly_poisha)
      VALUES ('${profile}', '${proId}', ${role}, '${slug}', '${headline}', '{cricket}', 'semi_pro', 5, ${area}, 'Five seasons scoring in the Dhaka leagues.', 'live', 1,
        jsonb_build_object('version', 1, 'headline', '${headline}', 'specialisation', null, 'sportKeys', '["cricket"]'::jsonb, 'experienceLevel', 'semi_pro', 'years', 5, 'baseAreaId', ${area}, 'bio', 'Five seasons scoring in the Dhaka leagues.', 'worksWithU16', false),
        now(), now(), '${headline}', 'semi_pro', ${area}, 62500);
    INSERT INTO rate_cards (id, profile_id, version, night_pct, short_notice_pct, short_notice_hours, travel_north_poisha, travel_south_poisha, travel_outside_poisha, max_jobs_per_day)
      VALUES ('${card}', '${profile}', 1, 20, 15, 48, 30000, 50000, 150000, 2);
    INSERT INTO rate_card_items (id, rate_card_id, unit, format, rate_poisha) VALUES (gen_random_uuid(), '${card}', 'match', 'T20', 250000), (gen_random_uuid(), '${card}', 'match', 'T10', 150000);
  `);
  return { profile, slug };
}

/** Move a hire job (and its busy guard) to start `minutes` from now, keeping its length. */
export function moveHireJob(jobId: string, minutes: number) {
  sql(`
    UPDATE hire_jobs SET
      end_at = now() + make_interval(mins => ${minutes}) + (end_at - start_at),
      busy = tstzrange(now() + make_interval(mins => ${minutes - 30}), now() + make_interval(mins => ${minutes + 30}) + (end_at - start_at), '[)'),
      start_at = now() + make_interval(mins => ${minutes})
    WHERE id = '${jobId}';
  `);
}

/**
 * M20: the owner's gym_owner role and a live gym open around the clock with the design packages (day
 * ৳400, month ৳4,500, quarter ৳12,000), written straight into the database (dev only; the Postman
 * run covers the listing, the review and the limits).
 */
export function liveGym(ownerId: string, run: string) {
  const g = randomUUID();
  const slug = `e2e-iron-yard-${run}`;
  const name = `E2E Iron Yard ${run}`;
  const area = "(SELECT id FROM areas WHERE key = 'banani')";
  const pkgs = [
    { id: randomUUID(), kind: "month", title: "Monthly", price: 450000, days: 30 },
    { id: randomUUID(), kind: "quarter", title: "Quarterly", price: 1200000, days: 90 },
  ];
  const hours = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, openTime: "00:00", closeTime: "24:00", womenOnly: false }));
  sql(`
    UPDATE user_roles SET status = 'active', activated_at = now() WHERE user_id = '${ownerId}' AND role = 'member';
    INSERT INTO user_roles (id, user_id, role, status, activated_at) SELECT gen_random_uuid(), '${ownerId}', 'member', 'active', now() WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = '${ownerId}' AND role = 'member');
    INSERT INTO user_roles (id, user_id, role, status, activated_at) VALUES (gen_random_uuid(), '${ownerId}', 'gym_owner', 'active', now());
    UPDATE users SET kyc_status = 'verified', authz_version = authz_version + 1 WHERE id = '${ownerId}';
    INSERT INTO gyms (id, owner_id, slug, name, area_id, address_line, about, status, live_version, first_live_at, status_changed_at, public_name, public_area_id, public_day_price_poisha, public_month_price_poisha, live_snapshot)
      VALUES ('${g}', '${ownerId}', '${slug}', '${name}', ${area}, 'House 9, Road 11, Banani, Dhaka', 'Free weights, squat racks and showers.', 'live', 1, now(), now(), '${name}', ${area}, 40000, 450000,
        jsonb_build_object('version', 1, 'name', '${name}', 'areaId', ${area}, 'addressLine', 'House 9, Road 11, Banani, Dhaka', 'lat', null, 'lng', null, 'about', 'Free weights, squat racks and showers.',
          'facilityIds', '[]'::jsonb, 'photos', '[]'::jsonb, 'hours', '${JSON.stringify(hours)}'::jsonb, 'packages', '${JSON.stringify(pkgs)}'::jsonb));
    INSERT INTO gym_hours (id, gym_id, dow, open_time, close_time, women_only) SELECT gen_random_uuid(), '${g}', d, '00:00', '24:00', false FROM generate_series(0, 6) d;
    ${pkgs.map((p) => `INSERT INTO gym_packages (id, gym_id, kind, title, price_poisha, days, status) VALUES ('${p.id}', '${g}', '${p.kind}', '${p.title}', ${p.price}, ${p.days}, 'active');`).join("\n    ")}
  `);
  return { id: g, slug, name };
}

/**
 * M22: a verified organisation owned by `ownerId` (organiser role active, owner member), an active
 * percentage contract at the setting (10%) with its signed PDF on file, and a claimed subdomain,
 * written straight into the database (dev only; the Postman run covers the review and the contract).
 */
export function verifiedOrganiser(ownerId: string, run: string) {
  const id = randomUUID();
  const name = `E2E Clutch League ${run}`;
  const subdomain = `e2e-clutch-${run}`;
  sql(`
    UPDATE user_roles SET status = 'active', activated_at = now() WHERE user_id = '${ownerId}' AND role = 'member';
    INSERT INTO user_roles (id, user_id, role, status, activated_at) SELECT gen_random_uuid(), '${ownerId}', 'member', 'active', now() WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = '${ownerId}' AND role = 'member');
    INSERT INTO user_roles (id, user_id, role, status, activated_at) VALUES (gen_random_uuid(), '${ownerId}', 'organiser', 'active', now());
    UPDATE users SET kyc_status = 'verified', authz_version = authz_version + 1 WHERE id = '${ownerId}';
    INSERT INTO organisations (id, kind, owner_user_id, name, slug, about, status, verified_at, status_changed_at)
      VALUES ('${id}', 'esports', '${ownerId}', '${name}', 'e2e-clutch-league-${run}', 'Weekly Free Fire scrims.', 'verified', now(), now());
    INSERT INTO organisation_members (id, organisation_id, user_id, role, status) VALUES (gen_random_uuid(), '${id}', '${ownerId}', 'owner', 'active');
    INSERT INTO organiser_contracts (id, organisation_id, model, billing_cycle, starts_on, status, signed_document_key, activated_at)
      VALUES (gen_random_uuid(), '${id}', 'percentage', 'per_tournament', (now() AT TIME ZONE 'Asia/Dhaka')::date, 'active', 'contracts/${id}/e2e.pdf', now());
    INSERT INTO organisation_branding (organisation_id, subdomain, primary_hex, accent_hex, tagline_en, status) VALUES ('${id}', '${subdomain}', '#0b7a4b', '#f2a33a', 'Weekly scrims', 'live');
  `);
  return { id, name, subdomain };
}

/**
 * M23: a published, featured big event running now, with a live YouTube stream (parsed reference),
 * a title sponsor and an open two-option poll, written straight into the database (dev only; the
 * Postman run covers the links, qualifiers and the desk).
 */
export function liveBigEvent(run: string) {
  const id = randomUUID();
  const slug = `e2e-championship-${run}`;
  const title = `E2E Championship ${run}`;
  const poll = randomUUID();
  const [a, b] = [randomUUID(), randomUUID()];
  sql(`
    INSERT INTO esports_events (id, slug, title_en, title_bn, tagline_en, starts_at, ends_at, status, featured, published_at, created_by)
      VALUES ('${id}', '${slug}', '${title}', 'ই২ই চ্যাম্পিয়নশিপ ${run}', 'Qualify online, win the final', now() - interval '1 hour', now() + interval '2 days', 'published', true, now(), gen_random_uuid());
    INSERT INTO esports_event_streams (id, event_id, platform, url, video_ref, title, is_live, sort) VALUES (gen_random_uuid(), '${id}', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'yt:v:dQw4w9WgXcQ', 'Main stage', true, 0);
    INSERT INTO esports_event_sponsors (id, event_id, name, tier, url, sort) VALUES (gen_random_uuid(), '${id}', 'E2E Walton', 'title', 'https://walton.example', 0);
    INSERT INTO esports_event_polls (id, event_id, question_en, question_bn, status, opened_at) VALUES ('${poll}', '${id}', 'Who wins the final?', 'ফাইনালে কে জিতবে?', 'open', now());
    INSERT INTO esports_event_poll_options (id, poll_id, label_en, label_bn, sort) VALUES ('${a}', '${poll}', 'Team Alpha', 'টিম আলফা', 0), ('${b}', '${poll}', 'Team Bravo', 'টিম ব্রাভো', 1);
  `);
  return { id, slug, title };
}

/**
 * M16: mark an account NID-verified with an active member role (dev only; the Postman runs cover the
 * M02 review). The team page then shows "NID ✓" for that member.
 */
export function nidVerified(userId: string) {
  sql(`
    UPDATE user_roles SET status = 'active', activated_at = now() WHERE user_id = '${userId}' AND role = 'member';
    INSERT INTO user_roles (id, user_id, role, status, activated_at) SELECT gen_random_uuid(), '${userId}', 'member', 'active', now() WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = '${userId}' AND role = 'member');
    UPDATE users SET kyc_status = 'verified', authz_version = authz_version + 1 WHERE id = '${userId}';
  `);
}

/**
 * M14: a verified sports organisation owned by `ownerId` (organiser role active, owner member, NID
 * verified) with an active bKash payout account, written straight into the database (dev only; the
 * Postman run covers the organisation review).
 */
export function verifiedSportsOrg(ownerId: string, run: string) {
  const id = randomUUID();
  const name = `E2E Mirpur Club ${run}`;
  sql(`
    UPDATE user_roles SET status = 'active', activated_at = now() WHERE user_id = '${ownerId}' AND role = 'member';
    INSERT INTO user_roles (id, user_id, role, status, activated_at) SELECT gen_random_uuid(), '${ownerId}', 'member', 'active', now() WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = '${ownerId}' AND role = 'member');
    INSERT INTO user_roles (id, user_id, role, status, activated_at) VALUES (gen_random_uuid(), '${ownerId}', 'organiser', 'active', now());
    UPDATE users SET kyc_status = 'verified', authz_version = authz_version + 1 WHERE id = '${ownerId}';
    INSERT INTO organisations (id, kind, owner_user_id, name, slug, about, status, verified_at, status_changed_at)
      VALUES ('${id}', 'sports', '${ownerId}', '${name}', 'e2e-mirpur-club-${run}', 'Weekend leagues.', 'verified', now(), now());
    INSERT INTO organisation_members (id, organisation_id, user_id, role, status) VALUES (gen_random_uuid(), '${id}', '${ownerId}', 'owner', 'active');
    INSERT INTO payout_accounts (id, user_id, type, account_no_enc, account_no_hash, account_no_last4, account_name, status, activated_at)
      VALUES (gen_random_uuid(), '${ownerId}', 'bkash', 'e2e', md5('${id}') || md5('${run}'), '5678', 'E2E Organiser', 'active', now());
  `);
  return { id, name };
}
