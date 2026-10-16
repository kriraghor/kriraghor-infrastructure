import { expect, test } from "@playwright/test";
import { ADMIN, API, WEB, masterToken, signUpByPhone, testPhone } from "./helpers";

/**
 * M02 in k3d: "A KYC document is approved" (the last part of the Phase 2 exit check).
 *  1. A member signs up by phone and opens /account/verification: "Verification needed".
 *  2. They fill the NID form (legal name, number, date of birth, front, back, selfie) and send it: "In review".
 *  3. The master finds it on the KYC queue (API), views a file (audited) and approves it with the full rubric.
 *  4. The member's page shows "Fully verified", and their account page says "Identity verified".
 */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`e2e-${Date.now()}`)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`e2e-${Date.now()}`)]);

test("a member verifies their NID and staff approve it", async ({ browser, request }) => {
  test.setTimeout(4 * 60_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const phone = testPhone();
  const { userId } = await signUpByPhone(page, WEB, phone, "E2E Verified Member");
  // A unique 17-digit NID per run (the platform refuses one NID on two accounts).
  const nid = `1990${String(Date.now()).slice(-13)}`;

  await page.goto(`${WEB}/account/verification`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Verify your identity");
  await expect(page.getByTestId("kyc-badge")).toContainText("Verification needed");
  await page.getByTestId("start-nid").click();
  await page.getByLabel("Full name on the NID").fill("E2E Verified Member");
  await page.getByLabel("NID number").fill(nid);
  await page.getByLabel("Date of birth").fill("1990-05-14");
  await page.getByTestId("file-front").setInputFiles({ name: "front.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await page.getByTestId("file-back").setInputFiles({ name: "back.png", mimeType: "image/png", buffer: PNG });
  await page.getByTestId("file-selfie").setInputFiles({ name: "selfie.jpg", mimeType: "image/jpeg", buffer: Buffer.concat([JPEG, Buffer.from("selfie")]) });
  await expect(page.getByText("Uploaded")).toHaveCount(3);
  await page.getByLabel(/Kriraghor uses these documents/).check();
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByTestId("kyc-badge")).toContainText("Documents in review");
  await expect(page.getByTestId("kyc-items")).toContainText(`•••• ${nid.slice(-4)}`);
  await expect(page.getByText(nid)).toHaveCount(0);

  // Staff review on the KYC desk (API with the master's admin session).
  const token = await masterToken(request, page);
  const admin = { Authorization: `Bearer ${token}`, Origin: ADMIN };
  const queue = await (await request.get(`${API}/admin/kyc/documents?status=in_review`, { headers: admin })).json();
  const doc = queue.items.find((d: { user: { id: string } }) => d.user.id === userId);
  expect(doc).toMatchObject({ numberMasked: `•••• ${nid.slice(-4)}`, failedChecks: [] });
  expect(JSON.stringify(queue)).not.toContain(nid);
  const detail = await (await request.get(`${API}/admin/kyc/documents/${doc.id}`, { headers: admin })).json();
  expect(detail.fields).toMatchObject({ legalName: "E2E Verified Member", dob: "1990-05-14" });
  const front = detail.files.find((f: { slot: string }) => f.slot === "front");
  const file = await request.get(`${API}/admin/kyc/documents/${doc.id}/files/${front.id}`, { headers: admin });
  expect(file.status()).toBe(200);
  expect(file.headers()["cache-control"]).toBe("no-store");
  const decided = await request.post(`${API}/admin/kyc/documents/${doc.id}/decide`, {
    headers: admin,
    data: { decision: "approve", rubric: { nameMatches: true, readable: true, notExpired: true } },
  });
  expect(decided.status()).toBe(200);

  // The worker moves the member role (M01 consumer); the page follows.
  await expect(async () => {
    await page.goto(`${WEB}/account/verification`);
    await expect(page.getByTestId("kyc-badge")).toContainText("Fully verified", { timeout: 2000 });
  }).toPass({ timeout: 60_000 });
  await page.goto(`${WEB}/me`);
  await expect(page.getByTestId("me-verification")).toHaveText("Identity verified");
  await ctx.close();
});
