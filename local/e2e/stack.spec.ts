import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { ADMIN, D, ESPORTS, MASTER_PHONE, STATE_FILE, VENDOR, WEB, emailCode, masterTotp, smsCode } from "./helpers";

/**
 * 0B exit check (build prompt, Part 4): the whole stack runs in k3d and SSO works across subdomains.
 *  1. Sign up with an email code on esports.kriraghor.localhost.
 *  2. kriraghor.localhost/me shows the same account without signing in again (ADR-004).
 *  3. The realtime connection joins user:{id} through the ingress.
 *  4. admin.kriraghor.localhost requires the staff sign-in, including TOTP, and gives an admin session.
 *  5. Each portal host serves only its own area.
 */

test("SSO across subdomains: sign up on esports, same session on kriraghor.com", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const helper = await context.newPage();
  const email = `e2e+${Date.now()}@kriraghor.test`;

  await page.goto(`${ESPORTS}/sign-in`);
  await page.getByRole("tab", { name: "Email code" }).click();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();

  await page.getByLabel("6-digit code").fill(await emailCode(helper, email));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.getByLabel("Your name").fill("E2E Player");
  await page.getByRole("button", { name: "Create my account" }).click();

  await expect(page).toHaveURL(`${ESPORTS}/me`);
  await expect(page.getByTestId("me-name")).toHaveText("E2E Player");
  const userId = (await page.getByTestId("me-id").textContent())?.trim();
  expect(userId).toMatch(/^[0-9a-f-]{36}$/);

  // Realtime through the ingress (/socket.io on the API host).
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-connected", "true");
  await expect(page.getByTestId("live-status")).toContainText(`user:${userId}`);

  // Cookies: refresh token host-only on the API, hints readable on every subdomain.
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "kg_rt")).toMatchObject({ domain: `api.${D}`, httpOnly: true, sameSite: "Lax" });
  expect(cookies.find((c) => c.name === "kg_si")).toMatchObject({ domain: `.${D}`, httpOnly: false });

  // A different subdomain: no sign-in, same account.
  const web = await context.newPage();
  await web.goto(`${WEB}/me`);
  await expect(web.getByTestId("me-id")).toHaveText(userId!);
  await expect(web.getByTestId("me-name")).toHaveText("E2E Player");

  // Signing out on one site signs out everywhere.
  await web.getByRole("button", { name: "Sign out" }).click();
  await page.goto(`${ESPORTS}/me`);
  await expect(page.getByTestId("signed-out")).toBeVisible();
  await context.close();
});

test("admin portal requires staff sign-in with TOTP and gives an admin session", async ({ browser }) => {
  // Room to wait out the login-code cooldown, which grows after many master sign-ins in one session.
  test.setTimeout(6 * 60_000);
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(ADMIN);
  await expect(page).toHaveURL(`${ADMIN}/admin/sign-in`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff sign-in");

  await page.getByRole("button", { name: "Phone code" }).click();
  await page.getByLabel("Mobile number").fill(MASTER_PHONE);
  // The API allows one code per number per 60 s (M01); on a quick rerun, wait out the cooldown it reports.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole("button", { name: "Send code" }).click();
    const codeField = page.getByLabel("6-digit code");
    const cooldown = page.getByRole("alert").filter({ hasText: /Try again in \d+ seconds/ });
    await expect(codeField.or(cooldown)).toBeVisible();
    if (await codeField.isVisible()) break;
    const seconds = Number((await cooldown.textContent())?.match(/(\d+) seconds/)?.[1] ?? 60);
    await page.waitForTimeout((seconds + 1) * 1000);
  }
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  await page.getByLabel("6-digit code").fill(smsCode(MASTER_PHONE));
  await page.getByRole("button", { name: "Verify and continue" }).click();

  // First run enrols the authenticator; later runs reuse the saved secret.
  const totpField = page.getByLabel("Authenticator code");
  await expect(totpField).toBeVisible();
  if (await page.getByTestId("totp-secret").isVisible()) {
    const secret = ((await page.getByTestId("totp-secret").textContent()) ?? "").trim();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ secret }));
  }
  // masterTotp never reuses a 30 s step that an earlier spec in this run already spent.
  await totpField.fill(await masterTotp(page));
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(page).toHaveURL(`${ADMIN}/admin`);
  await expect(page.getByTestId("admin-welcome")).toContainText("Ayesha Siddiqua");
  await expect(page.getByTestId("live-status")).toContainText("staff");

  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "kg_art")).toMatchObject({ domain: `api.${D}`, httpOnly: true, sameSite: "Strict" });
  expect(cookies.find((c) => c.name === "kg_rt")).toBeUndefined(); // no customer session for staff (Q33)

  // The admin session is not a customer session: kriraghor.com stays signed out.
  const web = await context.newPage();
  await web.goto(`${WEB}/me`);
  await expect(web.getByTestId("signed-out")).toBeVisible();
  await context.close();
});

test("each portal host serves only its own area", async ({ page }) => {
  expect((await page.goto(`${VENDOR}/admin`))?.status()).toBe(404);
  expect((await page.goto(`${ADMIN}/vendor`))?.status()).toBe(404);
  const vendorHome = await page.goto(VENDOR);
  expect(vendorHome?.status()).toBe(200);
  await expect(page).toHaveURL(`${VENDOR}/vendor`);
});
