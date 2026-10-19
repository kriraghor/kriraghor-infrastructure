import { expect, test, type Page } from "@playwright/test";
import { bookTomorrow, liveGround, startNow } from "./fixtures";
import { VENDOR, WEB, signUpByPhone, sql, testPhone } from "./helpers";

/**
 * M10 in k3d, on the v3 money rules:
 *  1. An owner (fixture: an active ground_owner role and a live two-court ground at ৳2,000/h flat with a
 *     25% advance, written straight into the dev database; the M09 spec covers the real listing flow).
 *  2. A member picks tomorrow's first free slot in the booking widget on /venues/[slug], holds it, pays
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
  await member.goto(`${WEB}/venues/${g.slug}`);
  await member.getByTestId("booking-widget").getByRole("tab").nth(1).click();
  await expect(member.getByTestId("slot-grid").locator('[data-state="yours"]').first()).toBeVisible();
  await shot(member, "booking-widget");

  // 3. The owner's day; at the start, check in.
  await owner.goto(`${VENDOR}/vendor/bookings`);
  await owner.getByRole("tab").nth(2).click(); // yesterday, today, tomorrow …
  await expect(owner.getByTestId("timeline-booking").first()).toBeVisible();
  await shot(owner, "vendor-timeline");
  startNow(first);
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

  await owner.goto(`${VENDOR}/vendor/venues/${g.id}/schedule`);
  const day3 = owner.locator("select").first();
  await day3.selectOption({ index: 3 });
  await owner.getByTestId("create-closure").click();
  await expect(owner.getByRole("button", { name: "Reopen" }).first()).toBeVisible();
  await owner.getByTestId("create-closure").click(); // the same period again: it clashes with the first
  await expect(owner.getByTestId("clashes")).toContainText("Closure");
  await shot(owner, "vendor-schedule");
});
