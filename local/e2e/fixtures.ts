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
  await page.goto(`${WEB}/grounds/${slug}`);
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
