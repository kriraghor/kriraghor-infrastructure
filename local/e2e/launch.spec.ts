import { expect, test, type Page } from "@playwright/test";
import { ESPORTS, WEB, signUpByPhone, smsCode, sql, testPhone } from "./helpers";
import { liveGround } from "./fixtures";

/**
 * kriraghor.com launch polish in k3d:
<<<<<<< HEAD
 *  1. The home renders the hero, the finder (venues tab → /venues?sport=football) and live grounds.
=======
 *  1. The home renders the hero, the finder (grounds tab → /grounds?sport=football) and live grounds.
>>>>>>> origin/feat/web-launch-polish
 *  2. Every footer link answers 200; /go/esports redirects to esports.kriraghor.localhost.
 *  3. Forgot password: a phone code, a new password, signed in with it; the PASSWORD_CHANGED alert is
 *     stored with an SMS delivery.
 *  4. Unknown pages and unknown grounds show the 404 page (status 404).
 *  5. /sitemap.xml lists the public pages; /robots.txt keeps dev out of search.
 *  6. On a phone: the tab bar and the menu.
 * Two OTPs (signup and reset).
 */
test("kriraghor.com: home, footer, forgot password, 404, sitemap and the phone layout", async ({ browser, request }) => {
  test.setTimeout(10 * 60_000);
  const run = String(Date.now()).slice(-6);
  const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/launch-${name}.png`, fullPage: true });

  // A member, and a live ground for the home and the sitemap.
  const member = await (await browser.newContext()).newPage();
  const phone = testPhone();
  const { userId } = await signUpByPhone(member, WEB, phone, "E2E Launch Member");
  liveGround(userId, run);

  // 1. Home.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(WEB);
  await expect(visitor.getByTestId("home-title")).toBeVisible();
  await expect(visitor.getByTestId("finder")).toBeVisible();
  await expect(visitor.getByTestId("next-up").or(visitor.getByTestId("next-up-empty"))).toBeVisible();
  await expect(visitor.getByTestId("home-ground").first()).toBeVisible({ timeout: 30_000 });
  await shot(visitor, "home");
<<<<<<< HEAD
  await visitor.getByRole("tab", { name: "Venues" }).click();
  await expect(visitor.getByLabel("Sport").locator("option", { hasText: "Football" })).toHaveCount(1);
  await visitor.getByLabel("Sport").selectOption({ label: "Football" });
  await visitor.getByTestId("finder-go").click();
  await expect(visitor).toHaveURL(`${WEB}/venues?sport=football`);
=======
  await visitor.getByRole("tab", { name: "Grounds" }).click();
  await expect(visitor.getByLabel("Sport").locator("option", { hasText: "Football" })).toHaveCount(1);
  await visitor.getByLabel("Sport").selectOption({ label: "Football" });
  await visitor.getByTestId("finder-go").click();
  await expect(visitor).toHaveURL(`${WEB}/grounds?sport=football`);
>>>>>>> origin/feat/web-launch-polish

  // 2. Footer links, and the esports redirect.
  await visitor.goto(WEB);
  const hrefs = await visitor.getByTestId("site-footer").locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  expect(hrefs.length).toBeGreaterThan(15);
  for (const href of hrefs.filter((h) => h.startsWith("/") && !h.startsWith("/go/"))) {
    expect([href, (await request.get(`${WEB}${href}`)).status()]).toEqual([href, 200]);
  }
<<<<<<< HEAD
  const go = await request.get(`${WEB}/go/esports/events`, { maxRedirects: 0 });
  expect(go.status()).toBe(307);
  expect(go.headers().location).toBe(`${ESPORTS}/events`);
=======
  const go = await request.get(`${WEB}/go/esports/tournaments`, { maxRedirects: 0 });
  expect(go.status()).toBe(307);
  expect(go.headers().location).toBe(`${ESPORTS}/tournaments`);
>>>>>>> origin/feat/web-launch-polish
  await visitor.goto(`${WEB}/terms`);
  await expect(visitor.getByTestId("legal-page")).toContainText("Draft, under legal review");

  // 3. Forgot password (a fresh browser, as if on another device). One code per minute per number.
  const device = await (await browser.newContext()).newPage();
  await device.goto(`${WEB}/sign-in`);
<<<<<<< HEAD
  await device.getByTestId("use-password").click();
=======
  await device.getByRole("tab", { name: "Password" }).click();
>>>>>>> origin/feat/web-launch-polish
  await device.getByTestId("forgot-password").click();
  await expect(device).toHaveURL(`${WEB}/sign-in/reset`);
  await device.waitForTimeout(61_000);
  await device.getByLabel("Phone or email").fill(phone);
  await device.getByRole("button", { name: "Send code" }).click();
  await expect(device.getByLabel("6-digit code")).toBeVisible();
  await device.getByLabel("6-digit code").fill(smsCode(phone));
  await device.getByLabel("New password").fill(`Launch-Ready-${run}`);
  await device.getByLabel("Type it again").fill(`Launch-Ready-${run}`);
  await device.getByRole("button", { name: "Save new password" }).click();
  await expect(device.getByRole("heading", { name: "Password changed" })).toBeVisible();
  await shot(device, "reset-done");
  await device.getByLabel("Password", { exact: true }).fill(`Launch-Ready-${run}`);
  await device.getByRole("button", { name: "Sign in" }).click();
  await expect(device).toHaveURL(`${WEB}/me`);
  await expect
    .poll(() => sql(`SELECT count(*) FROM notifications n JOIN notification_deliveries d ON d.notification_id = n.id AND d.channel = 'sms' WHERE n.user_id = '${userId}' AND n.code = 'PASSWORD_CHANGED'`).trim(), { timeout: 60_000 })
    .toBe("1");

  // 4. Not found.
  expect((await request.get(`${WEB}/no-such-page-${run}`)).status()).toBe(404);
<<<<<<< HEAD
  await visitor.goto(`${WEB}/venues/no-such-ground-${run}`);
=======
  await visitor.goto(`${WEB}/grounds/no-such-ground-${run}`);
>>>>>>> origin/feat/web-launch-polish
  await expect(visitor.getByTestId("not-found")).toBeVisible();

  // 5. Sitemap and robots.
  const sitemap = await (await request.get(`${WEB}/sitemap.xml`)).text();
<<<<<<< HEAD
  for (const path of ["/venues", "/shop", "/hiring", "/gym", "/events", "/terms", "/privacy"]) expect(sitemap).toContain(`<loc>http://kriraghor.localhost${path}</loc>`);
=======
  for (const path of ["/grounds", "/shop", "/hiring", "/gym", "/tournaments", "/terms", "/privacy"]) expect(sitemap).toContain(`<loc>http://kriraghor.localhost${path}</loc>`);
>>>>>>> origin/feat/web-launch-polish
  expect(sitemap).not.toContain("/me<");
  const robots = await (await request.get(`${WEB}/robots.txt`)).text();
  expect(robots).toContain("Disallow: /");

  // 6. A phone: the tab bar and the menu.
  const phoneCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true });
  const mobile = await phoneCtx.newPage();
  await mobile.goto(WEB);
  await expect(mobile.getByTestId("tab-bar")).toBeVisible();
  await mobile.getByTestId("menu-button").click();
  await expect(mobile.getByTestId("site-menu").getByRole("link", { name: "Gym" })).toBeVisible();
  await shot(mobile, "phone-menu");
});
