import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { liveGym } from "./fixtures";
import { GYM, VENDOR, WEB, signUpByPhone, sql, testPhone } from "./helpers";

/**
 * M20 in k3d, on the gym app (gym.kriraghor.localhost, M24 D1): a monthly subscription end to end.
 *  1. A gym owner with a live gym open around the clock, monthly ৳4,500 (fixture; the Postman run
 *     covers the listing and the review), and a member with a verified phone. The old gym URLs on
 *     kriraghor.com and vendor.kriraghor.com answer 308 to the gym app, query kept (M24 §4.3).
 *  2. The member finds the gym on /gyms, buys a month from today and pays with bKash on the simulator
 *     (the pay page stays on kriraghor.com): the money waits in escrow (one hold of ৳4,500).
 *  3. /me/passes shows the pass with its QR and the 6-character backup code.
 *  4. The owner types the code at the front desk (/manage/:gymId/desk): admitted. A second try is
 *     refused for the day ("Already used at …"). The owner's payable is ৳4,275 (5% fee); today's admissions list it.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/gym-${name}.png`, fullPage: true });
const balance = (code: string) => Number(sql(`SELECT COALESCE(SUM(e.credit_poisha - e.debit_poisha), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = '${code}'`));

/** The old URL answers a permanent redirect (308) to `to`, without following it. */
async function redirects(request: APIRequestContext, from: string, to: string) {
  const res = await request.get(from, { maxRedirects: 0 });
  expect(res.status(), from).toBe(308);
  expect(res.headers().location, from).toBe(to);
}

test("a member buys a ৳4,500 month, shows its code at the front desk once a day, and the gym is paid ৳4,275", async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const run = String(Date.now()).slice(-6);
  const owner = await (await browser.newContext()).newPage();
  const member = await (await browser.newContext()).newPage();

  // 1. The owner and the gym (fixture), and the member.
  const { userId: ownerId } = await signUpByPhone(owner, WEB, testPhone(), `E2E Gym Owner ${run}`);
  const gym = liveGym(ownerId, run);
  await signUpByPhone(member, WEB, testPhone(), `E2E Member ${run}`);

  // The old gym pages moved to the gym app: 308 with the query kept (signed in, as a real tap would be).
  await redirects(member.request, `${WEB}/gym/gyms/${gym.slug}?ref=x`, `${GYM}/gyms/${gym.slug}?ref=x`);
  await redirects(member.request, `${WEB}/me/passes`, `${GYM}/me/passes`);
  await redirects(owner.request, `${VENDOR}/vendor/gyms/${gym.id}/desk`, `${GYM}/manage/${gym.id}/desk`);

  // 2. Find the gym and buy a month from today.
  await member.goto(`${GYM}/gyms`);
  await expect(member.getByTestId("gym-cards")).toContainText(gym.name);
  await shot(member, "hub");
  await member.goto(`${GYM}/gyms/${gym.slug}`);
  await expect(member.getByTestId("gym-name")).toHaveText(gym.name);
  const buy = member.getByTestId("pass-buy");
  await expect(buy.getByTestId("pass-date").first()).toHaveText("Today");
  await expect(buy.getByTestId("pass-pay")).toHaveText("Pay ৳4,500");
  await shot(member, "gym-page");
  await buy.getByTestId("pass-pay").click();
  await expect(member).toHaveURL(new RegExp(`^${WEB}/pay/`));
  await member.getByRole("radio", { name: "bKash" }).check();
  await member.getByTestId("pay-button").click();
  await member.getByRole("button", { name: "Pay with bKash" }).click();
  await expect(member.getByTestId("pay-result")).toHaveAttribute("data-outcome", "paid");
  const passCode = sql(`SELECT code FROM gym_passes WHERE gym_id = '${gym.id}' ORDER BY created_at DESC LIMIT 1`);
  expect(sql(`SELECT count(*) || '/' || sum(held_poisha) FROM escrow_holds WHERE payment_id = (SELECT payment_id FROM gym_passes WHERE code = '${passCode}')`)).toBe("1/450000");

  // 3. The pass with its QR and backup code.
  await expect(async () => {
    await member.goto(`${GYM}/me/passes/${passCode}`);
    await expect(member.getByTestId("pass-status")).toHaveText("Active", { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await expect(member.getByTestId("pass-qr")).toBeVisible();
  const backup = (await member.getByTestId("pass-backup").innerText()).trim();
  expect(backup).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  await shot(member, "pass-qr");
  await member.goto(`${GYM}/me/passes`);
  await expect(member.getByTestId("my-pass").first()).toContainText(passCode);

  // 4. The front desk admits it once.
  await owner.goto(`${GYM}/manage/${gym.id}/desk`);
  await owner.getByTestId("desk-code").fill(backup.toLowerCase());
  await owner.getByTestId("desk-admit").click();
  await expect(owner.getByTestId("desk-admitted")).toContainText(`E2E Member ${run}`);
  await expect(owner.getByTestId("desk-admitted")).toContainText(passCode);
  await expect(owner.getByTestId("desk-today")).toContainText(passCode);
  await shot(owner, "desk-admitted");
  await owner.getByTestId("desk-code").fill(backup);
  await owner.getByTestId("desk-admit").click();
  await expect(owner.getByTestId("desk-refused")).toContainText("Already used at");
  await shot(owner, "desk-refused");
  await expect.poll(() => balance(`payable:user:${ownerId}`)).toBe(427500);
  expect(sql(`SELECT status FROM gym_passes WHERE code = '${passCode}'`)).toBe("active");
  await member.goto(`${GYM}/me/passes/${passCode}`);
  await expect(member.getByTestId("pass-status")).toHaveText("Active");
});
