import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { ADMIN, API, VENDOR, WEB, masterStepUp, masterToken, signUpByPhone, smsCode, testPhone } from "./helpers";

/**
 * M09 in k3d: a member becomes a ground owner and lists a ground that goes live.
 *  1. The member verifies their NID on kriraghor.com; a reviewer (approve_documents + approve_listings,
 *     made by the master) approves it.
 *  2. On /account/business they apply as a ground owner and send the trade licence and the lease; the
 *     reviewer approves both and the ground_owner role becomes active.
 *  3. On vendor.kriraghor.com they add a ground, a court and three photos (to the public bucket), and
 *     send it for review; the reviewer sees the checks and approves it.
 *  4. The ground is on kriraghor.com/venues with its photos served from the assets host.
 *  5. The owner raises the base price on the pricing page and publishes; the public quote follows.
 */
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

/** A staff reviewer, signed in to the admin API (TOTP enrolled on first login). */
async function reviewerToken(request: APIRequestContext, page: Page, masterTok: string): Promise<string> {
  const phone = testPhone();
  const { userId } = await signUpByPhone(page, WEB, phone, "E2E Ground Reviewer");
  const made = await request.post(`${API}/admin/staff`, {
    headers: { Authorization: `Bearer ${masterTok}`, Origin: ADMIN, "X-Step-Up": await masterStepUp(request, page, masterTok, "staff.write") },
    data: { userId, employeeId: `KG-E2E-G-${Date.now()}`, permissions: ["approve_documents", "approve_listings"] },
  });
  expect(made.status()).toBe(201);
  const headers = { Origin: ADMIN };
  await page.waitForTimeout(61_000); // one login code per minute after the signup code
  expect((await request.post(`${API}/auth/otp/send`, { data: { target: phone, purpose: "login" } })).status()).toBe(202);
  const login = await (await request.post(`${API}/auth/admin/login`, { headers, data: { target: phone, code: smsCode(phone) } })).json();
  const { secret } = await (await request.post(`${API}/auth/2fa/totp/setup`, { headers, data: { challengeToken: login.challengeToken } })).json();
  const on = await request.post(`${API}/auth/2fa/totp/activate`, { headers, data: { challengeToken: login.challengeToken, code: authenticator.generate(secret) } });
  expect(on.ok()).toBeTruthy();
  return (await on.json()).accessToken as string;
}

/** Claim, tick every rubric item and approve the open submission of a kind sent by a user (or for a subject). */
async function approve(request: APIRequestContext, token: string, kind: string, match: (s: { subjectId: string; submittedBy: { id: string } }) => boolean) {
  const h = { Authorization: `Bearer ${token}`, Origin: ADMIN };
  let item: { id: string } | undefined;
  await expect(async () => {
    const queue = await (await request.get(`${API}/admin/submissions?status=pending_review&kind=${kind}`, { headers: h })).json();
    item = queue.items.find(match);
    expect(item).toBeTruthy();
  }).toPass({ timeout: 30_000 });
  const sub = await (await request.post(`${API}/admin/submissions/${item!.id}/claim`, { headers: h })).json();
  await request.put(`${API}/admin/submissions/${item!.id}/ticks`, { headers: h, data: { ticks: sub.rubric.items.map((i: { key: string }) => i.key) } });
  const d = await request.post(`${API}/admin/submissions/${item!.id}/decide`, { headers: { ...h, "Idempotency-Key": `e2e-${Date.now()}-${item!.id}` }, data: { decision: "approve" } });
  expect(d.status()).toBe(200);
  return sub as { checks: { key: string; result: string }[] };
}

test("a member becomes a ground owner, lists a ground, and it goes live with its prices", async ({ browser, request }) => {
  test.setTimeout(15 * 60_000);
  const run = String(Date.now()).slice(-6);
  const owner = await (await browser.newContext()).newPage();
  const staff = await (await browser.newContext()).newPage();
  const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/grounds-${name}.png`, fullPage: true });
  const photo = await staff.screenshot(); // a real PNG for the photos

  // 1. The owner signs up and verifies the NID; the reviewer approves it.
  const { userId } = await signUpByPhone(owner, WEB, testPhone(), `E2E Owner ${run}`);
  await owner.goto(`${WEB}/account/verification`);
  await owner.getByTestId("start-nid").click();
  await owner.getByLabel("Full name on the NID").fill(`E2E Owner ${run}`);
  await owner.getByLabel("NID number").fill(`1985${String(Date.now()).slice(-13)}`);
  await owner.getByLabel("Date of birth").fill("1985-03-02");
  for (const slot of ["front", "back", "selfie"]) await owner.getByTestId(`file-${slot}`).setInputFiles({ name: `${slot}.png`, mimeType: "image/png", buffer: Buffer.concat([photo, Buffer.from(slot)]) });
  await owner.getByLabel(/Kriraghor uses these documents/).check();
  await owner.getByRole("button", { name: "Send for review" }).click();
  await expect(owner.getByTestId("kyc-badge")).toContainText("Documents in review");

  const master = await masterToken(request, staff);
  const reviewer = await reviewerToken(request, staff, master);
  await approve(request, reviewer, "document", (s) => s.submittedBy.id === userId);

  // 2. Business documents on /account/business.
  await expect(async () => {
    await owner.goto(`${WEB}/account/business`);
    await expect(owner.getByTestId("business-apply")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await owner.getByRole("button", { name: "Start my venue owner application" }).click();
  const tl = owner.getByTestId("business-item-trade_license");
  await tl.getByRole("button", { name: "Send this document" }).click();
  await tl.getByLabel("Licence number").fill(`TRAD/DNCC/${run}`);
  await tl.getByLabel("Name on the licence").fill(`E2E Owner ${run} Sports`);
  await tl.getByLabel("Valid until").fill("2027-12-31");
  await owner.getByTestId("file-trade_license").setInputFiles({ name: "licence.pdf", mimeType: "application/pdf", buffer: PDF });
  await tl.getByTestId("consent-trade_license").check(); // M02, 25 Oct 2026: explicit consent before sending
  await tl.getByRole("button", { name: "Send for checking" }).click();
  await expect(tl).toContainText("Being checked");
  const lease = owner.getByTestId("business-item-deed_or_lease");
  await lease.getByRole("button", { name: "Send this document" }).click();
  await lease.getByLabel("Deed or lease").selectOption("lease");
  await owner.getByTestId("file-deed_or_lease").setInputFiles({ name: "lease.pdf", mimeType: "application/pdf", buffer: Buffer.concat([PDF, Buffer.from(run)]) });
  await lease.getByTestId("consent-deed_or_lease").check();
  await lease.getByRole("button", { name: "Send for checking" }).click();
  await expect(lease).toContainText("Being checked");
  await shot(owner, "business-docs");
  for (const doc of ["Trade licence", "Land deed or lease"]) {
    await approve(request, reviewer, "document", (s) => s.submittedBy.id === userId && (s as unknown as { title: string }).title.startsWith(doc));
  }
  await expect(async () => {
    await owner.goto(`${WEB}/account/business`);
    await expect(owner.getByTestId("business-status")).toContainText("approved venue owner", { timeout: 3000 });
  }).toPass({ timeout: 60_000 });

  // 3. The vendor desk (same account): a ground, a court and three photos; send for review.
  await owner.goto(`${VENDOR}/vendor`);
  await expect(owner.getByTestId("owner-active")).toBeVisible();
  await owner.goto(`${VENDOR}/vendor/venues`);
  await owner.getByTestId("add-ground").click();
  const form = owner.getByTestId("add-ground-form");
  await form.getByLabel("Venue name").fill(`E2E Turf ${run}`);
  await form.getByLabel("Area").selectOption({ label: "Mirpur" });
  await form.getByLabel("Address").fill("Section 2, Mirpur, Dhaka");
  await form.getByLabel("Base price per hour (৳)").fill("2400");
  await form.getByRole("button", { name: "Create draft" }).click();
  await expect(owner).toHaveURL(new RegExp(`${VENDOR}/vendor/venues/[0-9a-f-]{36}$`));
  const groundId = owner.url().split("/").pop()!;

  const court = owner.getByTestId("add-court");
  await court.getByLabel("Court name").fill("Court 1");
  await court.getByLabel("Surface").selectOption({ label: "Artificial turf" });
  await court.getByRole("button", { name: "Football" }).click();
  await court.getByRole("button", { name: "Add a court" }).click();
  await expect(owner.getByTestId("court-card")).toHaveCount(1);
  await owner.getByTestId("photo-input").setInputFiles([1, 2, 3].map((n) => ({ name: `ground-${n}.png`, mimeType: "image/png", buffer: Buffer.concat([photo, Buffer.from(`${run}-${n}`)]) })));
  await expect(owner.getByTestId("ground-photos").locator("img")).toHaveCount(3);
  await owner.getByTestId("submit-ground").click();
  await expect(owner.getByText("In review").first()).toBeVisible();
  await shot(owner, "vendor-ground");

  const claim = await approve(request, reviewer, "ground", (s) => s.subjectId === groundId);
  expect(claim.checks.filter((c) => c.result === "fail")).toEqual([]);

  // 4. Live on kriraghor.com, photos from the public bucket.
  await expect(async () => {
    await owner.goto(`${WEB}/venues?area=`);
    await expect(owner.getByTestId("ground-cards")).toContainText(`E2E Turf ${run}`, { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await shot(owner, "public-list");
  await owner.getByTestId("ground-cards").getByText(`E2E Turf ${run}`).click();
  await expect(owner.getByTestId("ground-name")).toHaveText(`E2E Turf ${run}`);
  const img = owner.getByTestId("ground-photo");
  await expect(img).toHaveAttribute("src", /assets\.kriraghor\.localhost\/kriraghor-public\/grounds\//);
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(owner.getByTestId("booking-aside")).toContainText("advance online");
  await shot(owner, "public-detail");
  const slug = owner.url().split("/").pop()!;
  const detail = await (await request.get(`${API}/grounds/${slug}`)).json();
  const courtId = detail.courts[0].id;
  const quote = async () => (await (await request.post(`${API}/grounds/${groundId}/quote`, { data: { courtIds: [courtId], start: "2026-11-02T06:00:00.000Z", minutes: 60 } })).json()).price;
  expect(await quote()).toBe(240000); // Mon 12:00 Dhaka, no peak

  // 5. New prices: draft, publish, and the public quote follows.
  await owner.goto(`${VENDOR}/vendor/venues/${groundId}/pricing`);
  await owner.getByLabel(/^Per hour/).fill("3000");
  await owner.getByTestId("save-draft").click();
  await expect(owner.getByText("Draft saved.")).toBeVisible();
  await owner.getByTestId("publish").click();
  await expect(owner.getByText("Published. New bookings use these prices.")).toBeVisible();
  await expect(owner.getByTestId("pricing-history")).toContainText("base ৳3,000/h");
  await shot(owner, "vendor-pricing");
  await expect.poll(quote, { timeout: 30_000 }).toBe(300000);
});
