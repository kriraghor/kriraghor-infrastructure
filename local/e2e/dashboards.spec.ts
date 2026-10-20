import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { bookTomorrow, liveGround, startNow } from "./fixtures";
import { ADMIN, MASTER_PHONE, STATE_FILE, VENDOR, WEB, masterTotp, signUpByPhone, smsCode, sql, testPhone } from "./helpers";

/**
 * M19 in k3d: a played booking reaches every dashboard.
 *  1. An owner (fixture ground at ৳2,000/h flat, 25% advance) and a member; the member books tomorrow's
 *     first free hour and pays the ৳500 advance; it is moved to start now and the owner checks it in.
 *  2. The worker writes the facts from the events; the views are refreshed (in the cluster that is
 *     analytics.refresh-mviews every 15 minutes; here the test refreshes them through SQL).
 *  3. The vendor home shows ৳2,000 revenue and one booking; /vendor/analytics shows the charts.
 *  4. kriraghor.com/me shows ৳500 spent online.
 *  5. The master's admin home shows the fee revenue.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/dashboards-${name}.png`, fullPage: true });
const refreshViews = () => sql("REFRESH MATERIALIZED VIEW kpi_mv_owner_day; REFRESH MATERIALIZED VIEW kpi_mv_owner_occupancy_day; REFRESH MATERIALIZED VIEW kpi_mv_owner_hour_day; REFRESH MATERIALIZED VIEW kpi_mv_platform_day;");

test("a played booking reaches the owner, member and platform dashboards", async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const run = String(Date.now()).slice(-6);
  const owner = await (await browser.newContext()).newPage();
  const member = await (await browser.newContext()).newPage();
  const admin = await (await browser.newContext()).newPage();

  const { userId: ownerId } = await signUpByPhone(owner, WEB, testPhone(), "E2E Dashboard Owner");
  const g = liveGround(ownerId, run);
  await member.waitForTimeout(1_100);
  await signUpByPhone(member, WEB, testPhone(), "E2E Dashboard Player");

  const id = await bookTomorrow(member, g.slug);
  startNow(id);
  await owner.goto(`${VENDOR}/vendor/bookings`);
  await owner.getByRole("tab").nth(1).click(); // today
  await owner.getByTestId("timeline-booking").first().click();
  await owner.getByTestId("check-in").click();
  await expect(owner.getByTestId("booking-panel")).toContainText("Checked in");

  // The worker consumes the events and writes the facts; then the views are refreshed.
  await expect.poll(() => sql(`SELECT status FROM kpi_fact_booking WHERE booking_id = '${id}'`), { timeout: 60_000, intervals: [2_000] }).toBe("checked_in");
  await expect.poll(() => sql(`SELECT COUNT(*) FROM kpi_fact_ledger_txn WHERE vertical = 'grounds' AND fee_revenue_poisha = 10000 AND posted_at > now() - interval '10 minutes'`), { timeout: 60_000, intervals: [2_000] }).not.toBe("0");
  refreshViews();

  // 3. The owner's numbers.
  await owner.goto(`${VENDOR}/vendor`);
  await expect(owner.getByTestId("tile-revenue")).toContainText("৳2,000");
  await expect(owner.getByTestId("tile-bookings")).toContainText("1");
  await shot(owner, "vendor-home");
  await owner.getByTestId("open-analytics").click();
  await expect(owner.getByRole("heading", { level: 1 })).toHaveText("Analytics");
  await expect(owner.getByText("Revenue by venue (this period)")).toBeVisible();
  await shot(owner, "vendor-analytics");

  // 4. The member's overview.
  await member.goto(`${WEB}/me`);
  await expect(member.getByTestId("tile-spent")).toContainText("৳500");
  await shot(member, "member-me");

  // 5. The master's platform overview (staff sign-in with TOTP).
  await admin.goto(ADMIN);
  await admin.getByRole("radio", { name: "Phone code" }).click();
  await admin.getByLabel("Mobile number").fill(MASTER_PHONE);
  for (let attempt = 0; attempt < 3; attempt++) {
    await admin.getByRole("button", { name: "Send code" }).click();
    const codeField = admin.getByLabel("6-digit code");
    const cooldown = admin.getByRole("alert").filter({ hasText: /Try again in \d+ seconds/ });
    await expect(codeField.or(cooldown)).toBeVisible();
    if (await codeField.isVisible()) break;
    const seconds = Number((await cooldown.textContent())?.match(/(\d+) seconds/)?.[1] ?? 60);
    await admin.waitForTimeout((seconds + 1) * 1000);
  }
  await admin.getByLabel("6-digit code").fill(smsCode(MASTER_PHONE));
  await admin.getByRole("button", { name: "Verify and continue" }).click();
  await expect(admin.getByLabel("Authenticator code")).toBeVisible();
  if (!fs.existsSync(STATE_FILE)) throw new Error("run stack.spec.ts first: the master's authenticator is enrolled there");
  await admin.getByLabel("Authenticator code").fill(await masterTotp(admin));
  await admin.getByRole("button", { name: "Confirm" }).click();
  await expect(admin.getByTestId("platform-overview")).toBeVisible();
  await expect(admin.getByTestId("tile-fee")).not.toContainText("৳0");
  await shot(admin, "admin-overview");
});
