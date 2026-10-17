import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { VENDOR, WEB, signUpByPhone, sql, testPhone } from "./helpers";

/**
 * M10 in k3d, on the v3 money rules:
 *  1. An owner (fixture: an active ground_owner role and a live two-court ground at ৳2,000/h flat with a
 *     25% advance, written straight into the dev database; the M09 spec covers the real listing flow).
 *  2. A member picks tomorrow's first free slot in the booking widget on /grounds/[slug], holds it, pays
 *     the ৳500 advance on the SSLCommerz simulator and comes back to the booking: confirmed, ৳1,500 due at
 *     the venue.
 *  3. The owner sees it on vendor.kriraghor.com/vendor/bookings; when it starts they check the player in:
 *     the ledger shows ৳400 to the owner and ৳100 fee.
 *  4. A second booking is cancelled by the member: the advance is kept (৳475 / ৳25).
 *  5. A third booking is moved to Court 2 from the booking panel; a closure on the schedule page clashes
 *     with another closure and shows the clash.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/bookings-${name}.png`, fullPage: true });
const balance = (code: string) => Number(sql(`SELECT COALESCE(SUM(e.credit_poisha - e.debit_poisha), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = '${code}'`));

/** The owner's roles and a live ground with two courts, open around the clock (dev database only). */
function liveGround(ownerId: string, run: string) {
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
async function bookTomorrow(page: Page, slug: string): Promise<string> {
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

test("book a slot, pay the advance, check in, cancel, move and close (v3 money)", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const run = String(Date.now()).slice(-6);
  const owner = await (await browser.newContext()).newPage();
  const member = await (await browser.newContext()).newPage();

  // 1. The owner and the fixture ground.
  const { userId: ownerId } = await signUpByPhone(owner, WEB, testPhone(), "E2E Owner");
  const g = liveGround(ownerId, run);
  await member.waitForTimeout(1_100); // a fresh test phone number
  await signUpByPhone(member, WEB, testPhone(), "E2E Player");

  // 2. Book and pay the advance.
  const first = await bookTomorrow(member, g.slug);
  await expect(member.getByTestId("due-at-venue")).toHaveText("৳1,500");
  await shot(member, "booking-detail");
  await member.goto(`${WEB}/grounds/${g.slug}`);
  await member.getByTestId("booking-widget").getByRole("tab").nth(1).click();
  await expect(member.getByTestId("slot-grid").locator('[data-state="yours"]').first()).toBeVisible();
  await shot(member, "booking-widget");

  // 3. The owner's day; at the start, check in.
  await owner.goto(`${VENDOR}/vendor/bookings`);
  await owner.getByRole("tab").nth(2).click(); // yesterday, today, tomorrow …
  await expect(owner.getByTestId("timeline-booking").first()).toBeVisible();
  await shot(owner, "vendor-timeline");
  sql(`UPDATE bookings SET start_at = date_trunc('hour', now()), end_at = date_trunc('hour', now()) + interval '1 hour' WHERE id = '${first}';
       UPDATE booking_slots SET period = tstzrange(date_trunc('hour', now()), date_trunc('hour', now()) + interval '1 hour', '[)') WHERE booking_id = '${first}' AND status = 'active';`);
  await owner.reload();
  await owner.getByRole("tab").nth(1).click(); // today
  await owner.getByTestId("timeline-booking").first().click();
  await owner.getByTestId("check-in").click();
  await expect(owner.getByTestId("booking-panel")).toContainText("Checked in");
  await expect(owner.getByTestId("panel-due")).toContainText("৳1,500");
  await shot(owner, "vendor-checked-in");
  expect(balance(`payable:user:${ownerId}`)).toBe(40000);
  expect(balance("fee_revenue:grounds")).toBeGreaterThanOrEqual(10000);
  const feesBefore = balance("fee_revenue:grounds");

  // 4. A second booking, cancelled by the member: the advance is kept.
  const second = await bookTomorrow(member, g.slug);
  await member.getByTestId("cancel-booking").click();
  await expect(member.getByRole("alertdialog")).toContainText("The advance of ৳500 is not refunded.");
  await member.getByTestId("confirm-cancel").click();
  await expect(member.getByTestId("booking-status")).toHaveText("Cancelled");
  expect(balance(`payable:user:${ownerId}`)).toBe(87500);
  expect(balance("fee_revenue:grounds") - feesBefore).toBe(2500);
  expect(second).not.toBe(first);

  // 5. A third booking moves to Court 2 from the panel; closures clash with each other.
  await bookTomorrow(member, g.slug);
  await owner.reload();
  await owner.getByRole("tab").nth(2).click();
  await owner.getByTestId("timeline-booking").first().click();
  await owner.getByRole("button", { name: "Move", exact: true }).click();
  await owner.getByRole("button", { name: /Court 2/ }).click();
  await expect(owner.getByTestId("booking-panel")).toHaveCount(1);
  await expect.poll(() => sql(`SELECT count(*) FROM bookings WHERE ground_id = '${g.id}' AND court_ids = ARRAY['${g.courts[1]}']::uuid[] AND status = 'confirmed'`)).toBe("1");

  await owner.goto(`${VENDOR}/vendor/grounds/${g.id}/schedule`);
  const day3 = owner.locator("select").first();
  await day3.selectOption({ index: 3 });
  await owner.getByTestId("create-closure").click();
  await expect(owner.getByRole("button", { name: "Reopen" }).first()).toBeVisible();
  await owner.getByTestId("create-closure").click(); // the same period again: it clashes with the first
  await expect(owner.getByTestId("clashes")).toContainText("Closure");
  await shot(owner, "vendor-schedule");
});
