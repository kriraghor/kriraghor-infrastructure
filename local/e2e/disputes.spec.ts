import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { bookTomorrow, liveGround } from "./fixtures";
import { ADMIN, MASTER_PHONE, STATE_FILE, VENDOR, WEB, masterTotp, signUpByPhone, smsCode, sql, testPhone } from "./helpers";

/**
 * M17 in k3d: a contested no-show and a rating.
 *  1. An owner (fixture ground at ৳2,000/h flat, 25% advance) and a member; the member books and pays
 *     the ৳500 advance; the booking is moved an hour back and the owner marks a no-show on the vendor
 *     desk. The ৳500 stays in escrow for the dispute window.
 *  2. On kriraghor.com the member contests it from the booking, with a statement and a photo.
 *  3. On vendor.kriraghor.com the owner gives their side.
 *  4. On admin.kriraghor.com the master decides half with an authenticator code: ৳250 back to the
 *     member, ৳237.50 to the owner, ৳12.50 fee (the ledger and the booking show it).
 *  5. The member rates a played booking; the review shows on /venues/[slug].
 */
const balance = (code: string) => Number(sql(`SELECT COALESCE(SUM(e.credit_poisha - e.debit_poisha), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = '${code}'`));
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/disputes-${name}.png`, fullPage: true });
// A tiny valid PNG (1×1), so the API's byte check accepts it.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function adminSignIn(admin: Page) {
  await admin.goto(ADMIN);
  await admin.getByRole("button", { name: "Phone code" }).click();
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
  // The session is set when the TOTP check answers; navigating earlier would cancel it.
  await expect(admin.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 15_000 });
}

test("a contested no-show is decided half on the desk, and a played booking is rated", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const run = String(Date.now()).slice(-6);
  const owner = await (await browser.newContext()).newPage();
  const member = await (await browser.newContext()).newPage();
  const admin = await (await browser.newContext()).newPage();

  const { userId: ownerId } = await signUpByPhone(owner, WEB, testPhone(), "E2E Dispute Owner");
  const g = liveGround(ownerId, run);
  await member.waitForTimeout(1_100);
  await signUpByPhone(member, WEB, testPhone(), "E2E Dispute Player");

  // 1. Book, then the owner marks a no-show (the booking is moved an hour back so the member is late).
  const id = await bookTomorrow(member, g.slug);
  sql(`UPDATE bookings SET start_at = date_trunc('hour', now()) - interval '1 hour', end_at = date_trunc('hour', now()) WHERE id = '${id}';
       UPDATE booking_slots SET period = tstzrange(date_trunc('hour', now()) - interval '1 hour', date_trunc('hour', now()), '[)') WHERE booking_id = '${id}' AND status = 'active';`);
  await owner.goto(`${VENDOR}/vendor/bookings`);
  // The booking's day tab: moved an hour back, it falls on yesterday just after Dhaka midnight.
  const day = sql("SELECT to_char((date_trunc('hour', now()) - interval '1 hour') AT TIME ZONE 'Asia/Dhaka', 'FMDD Mon')");
  await owner.getByRole("tab", { name: new RegExp(` ${day}$`) }).click();
  await owner.getByTestId("timeline-booking").first().click();
  await owner.getByTestId("no-show").click();
  await expect(owner.getByTestId("booking-panel")).toContainText("No-show");
  expect(sql(`SELECT retained_poisha || '/' || released_poisha FROM bookings WHERE id = '${id}'`)).toBe("50000/0");

  // 2. The member contests it with a statement and a photo.
  await member.goto(`${WEB}/me/bookings/${id}`);
  await member.getByTestId("dispute-no_show_contest").click();
  await member.getByLabel("What happened?").fill("We were at the gate at the start time and it was locked.");
  await member.getByTestId("submit-dispute").click();
  await expect(member).toHaveURL(new RegExp(`${WEB}/me/disputes/DSP-`));
  const code = member.url().split("/").pop()!;
  await expect(member.getByTestId("dispute-status")).toHaveText("Waiting for the other side");
  await member.locator("#evidence-file").setInputFiles({ name: "gate.png", mimeType: "image/png", buffer: PNG });
  await expect(member.getByTestId("dispute-timeline")).toContainText("Open the photo");
  expect(sql(`SELECT status FROM escrow_holds WHERE payment_id = (SELECT payment_id FROM bookings WHERE id = '${id}')`)).toBe("frozen");
  await shot(member, "member-case");

  // 3. The owner answers on the vendor desk.
  await owner.goto(`${VENDOR}/vendor/disputes/${code}`);
  await owner.getByLabel("Your side").fill("Nobody came; the guard was at the gate all evening.");
  await owner.getByTestId("owner-respond").click();
  await expect(owner.getByTestId("owner-case")).toContainText("Under review");
  await shot(owner, "vendor-case");

  // 4. The master decides half with an authenticator code.
  await adminSignIn(admin);
  await admin.goto(`${ADMIN}/admin/disputes?code=${code}`);
  const pane = admin.getByTestId("dispute-case");
  await expect(pane).toContainText(code);
  await expect(pane.getByTestId("case-held")).toHaveText("৳500");
  await pane.getByTestId("outcome-half").check();
  await expect(pane).toContainText("৳250 back · owner ৳237.50 · fee ৳12.50");
  await pane.getByLabel("Reason (the parties see it)").fill("The gate was locked for part of the hour.");
  await pane.getByTestId("master-decide").click();
  await admin.getByLabel("Authenticator code").fill(await masterTotp(admin));
  await admin.getByRole("button", { name: "Confirm" }).click();
  await expect(pane).toContainText("Decided");
  await shot(admin, "admin-desk");
  expect(sql(`SELECT refund_poisha || '/' || retained_poisha || '/' || released_poisha FROM bookings WHERE id = '${id}'`)).toBe("25000/25000/25000");
  expect(balance(`payable:user:${ownerId}`)).toBe(23750);
  await member.goto(`${WEB}/me/disputes/${code}`);
  await expect(member.getByTestId("dispute-outcome")).toHaveText("Half refunded");
  await expect(member.getByTestId("dispute-refund")).toHaveText("৳250");

  // 5. A played booking is rated; the review shows on the ground page.
  const played = await bookTomorrow(member, g.slug);
  sql(`UPDATE bookings SET status = 'completed', completed_at = now(), start_at = date_trunc('hour', now()) - interval '3 hours', end_at = date_trunc('hour', now()) - interval '2 hours' WHERE id = '${played}';
       UPDATE booking_slots SET status = 'released', released_at = now(), release_reason = 'cancelled' WHERE booking_id = '${played}' AND status = 'active';`);
  await member.goto(`${WEB}/me/bookings/${played}`);
  await member.getByTestId("star-4").click();
  await member.getByLabel("What was it like? (optional)").fill("Good turf and bright floodlights.");
  await member.getByTestId("submit-review").click();
  await expect(member.getByText("Thank you. Your rating is on the venue’s page.")).toBeVisible();
  await member.goto(`${WEB}/venues/${g.slug}`);
  await expect(member.getByTestId("ground-reviews")).toContainText("Good turf and bright floodlights.");
  await shot(member, "ground-reviews");
});
