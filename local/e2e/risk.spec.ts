import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, MASTER_PHONE, STATE_FILE, WEB, masterTotp, signUpByPhone, smsCode, sql, testPhone } from "./helpers";

/**
 * M18 in k3d: two accounts try one NID.
 *  1. Two members sign up and send the same NID on kriraghor.com/account/verification.
 *  2. The worker evaluates the second account (debounced, about 30 s): a critical accounts_per_nid
 *     flag. Nothing is frozen by the system (Q101).
 *  3. The master opens /admin/risk, sees the flag, opens the account and freezes payouts with an
 *     authenticator code (an M07 risk_freeze hold), then undoes it with another code.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/risk-${name}.png`, fullPage: true });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`e2e-risk-${Date.now()}`)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`e2e-risk-${Date.now()}`)]);

async function sendNid(page: Page, name: string, nid: string) {
  await page.goto(`${WEB}/account/verification`);
  await page.getByTestId("start-nid").click();
  await page.getByLabel("Full name on the NID").fill(name);
  await page.getByLabel("NID number").fill(nid);
  await page.getByLabel("Date of birth").fill("1990-05-14");
  await page.getByTestId("file-front").setInputFiles({ name: "front.jpg", mimeType: "image/jpeg", buffer: Buffer.concat([JPEG, Buffer.from(name)]) });
  await page.getByTestId("file-back").setInputFiles({ name: "back.png", mimeType: "image/png", buffer: Buffer.concat([PNG, Buffer.from(name)]) });
  await page.getByTestId("file-selfie").setInputFiles({ name: "selfie.jpg", mimeType: "image/jpeg", buffer: Buffer.concat([JPEG, Buffer.from(`selfie-${name}`)]) });
  await expect(page.getByText("Uploaded")).toHaveCount(3);
  await page.getByLabel(/Kriraghor uses these documents/).check();
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByTestId("kyc-badge")).toContainText("Documents in review");
}

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
  // Wait for the admin session before moving on (navigating away early leaves the desk signed out).
  await expect(admin.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 15_000 });
}

test("two accounts on one NID: a critical flag; the master freezes payouts with a code and undoes it", async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const nid = `1990${String(Date.now()).slice(-13)}`;
  const first = await (await browser.newContext()).newPage();
  const second = await (await browser.newContext()).newPage();
  const admin = await (await browser.newContext()).newPage();

  await signUpByPhone(first, WEB, testPhone(), "E2E Risk First");
  await sendNid(first, "E2E Risk First", nid);
  await second.waitForTimeout(1_100);
  const { userId } = await signUpByPhone(second, WEB, testPhone(), "E2E Risk Second");
  await sendNid(second, "E2E Risk Second", nid);

  // The worker's debounced evaluation raises the flag; nothing is frozen without a person.
  await expect.poll(() => sql(`SELECT severity || '/' || status FROM risk_flags WHERE user_id = '${userId}' AND rule_key = 'accounts_per_nid'`), { timeout: 120_000, intervals: [5_000] }).toBe("critical/open");
  expect(sql(`SELECT COUNT(*) FROM payout_holds WHERE payee_id = '${userId}'`)).toBe("0");

  await adminSignIn(admin);
  await expect(async () => {
    await admin.goto(`${ADMIN}/admin/risk`);
    await expect(admin.getByTestId("risk-flags")).toContainText("E2E Risk Second", { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await expect(admin.getByTestId("risk-flags")).toContainText("Same NID on several accounts");
  await expect(admin.getByText(nid)).toHaveCount(0);
  await shot(admin, "desk");

  await admin.getByTestId("risk-flags").getByRole("link", { name: "E2E Risk Second" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("E2E Risk Second");
  await admin.getByTestId("account-flags").getByRole("radio").first().check();
  await admin.getByTestId("risk-action").selectOption("freeze_payouts");
  await admin.getByLabel("Reason (10+ characters, kept in the audit log)").fill("Two accounts sent the same NID; checking.");
  await admin.getByTestId("take-action").click();
  await admin.getByLabel("Authenticator code").fill(await masterTotp(admin));
  await admin.getByRole("button", { name: "Confirm" }).click();
  await expect(admin.getByTestId("account-actions")).toContainText("Freeze payouts");
  expect(sql(`SELECT COUNT(*) FROM payout_holds WHERE payee_id = '${userId}' AND type = 'risk_freeze' AND lifted_at IS NULL`)).toBe("1");
  await shot(admin, "account-frozen");

  await admin.getByLabel("Why undo? (10+ characters)").fill("Siblings, confirmed on a call.");
  await admin.getByTestId("undo-action").first().click();
  await admin.getByLabel("Authenticator code").fill(await masterTotp(admin));
  await admin.getByRole("button", { name: "Confirm" }).click();
  await expect(admin.getByTestId("account-actions")).toContainText("Unfreeze payouts");
  expect(sql(`SELECT COUNT(*) FROM payout_holds WHERE payee_id = '${userId}' AND type = 'risk_freeze' AND lifted_at IS NULL`)).toBe("0");
  await shot(admin, "account-undone");
});
