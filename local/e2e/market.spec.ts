import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { ADMIN, API, VENDOR, WEB, masterStepUp, masterToken, signUpByPhone, smsCode, testPhone } from "./helpers";

/**
 * M12 in k3d: a member becomes a shop owner, opens a shop and sells boots in sizes.
 *  1. The member verifies their NID; a reviewer (approve_documents + approve_listings) approves it.
 *  2. On /account/business?as=shop they apply as a shop owner and send the trade licence and TIN
 *     (kept per role); the reviewer approves both and the shop_owner role becomes active.
 *  3. On vendor.kriraghor.com they open a sports gear shop; the reviewer approves it (kind shop).
 *  4. They add turf boots (item type football_boots, spec stud type), three EU sizes with opening stock
 *     and three photos, and send it for review; the reviewer sees no failing check and approves.
 *  5. On the inventory desk they count EU 44 down to 0 (count correction, the stock ledger).
 *  6. kriraghor.com/shop lists the boots under Football; the product page shows EU 44 sold out.
 */
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

async function reviewerToken(request: APIRequestContext, page: Page, masterTok: string): Promise<string> {
  const phone = testPhone();
  const { userId } = await signUpByPhone(page, WEB, phone, "E2E Market Reviewer");
  const made = await request.post(`${API}/admin/staff`, {
    headers: { Authorization: `Bearer ${masterTok}`, Origin: ADMIN, "X-Step-Up": await masterStepUp(request, page, masterTok, "staff.write") },
    data: { userId, employeeId: `KG-E2E-MK-${Date.now()}`, permissions: ["approve_documents", "approve_listings"] },
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

async function approve(request: APIRequestContext, token: string, kind: string, match: (s: { subjectId: string; title: string; submittedBy: { id: string } }) => boolean) {
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

test("a member becomes a shop owner, lists boots in sizes, and buyers see the sold-out size", async ({ browser, request }) => {
  test.setTimeout(15 * 60_000);
  const run = String(Date.now()).slice(-6);
  const owner = await (await browser.newContext()).newPage();
  const staff = await (await browser.newContext()).newPage();
  const buyer = await (await browser.newContext()).newPage();
  const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/market-${name}.png`, fullPage: true });
  const photo = await staff.screenshot(); // a real PNG for the photos

  // 1. NID.
  const { userId } = await signUpByPhone(owner, WEB, testPhone(), `E2E Shop ${run}`);
  await owner.goto(`${WEB}/account/verification`);
  await owner.getByTestId("start-nid").click();
  await owner.getByLabel("Full name on the NID").fill(`E2E Shop ${run}`);
  await owner.getByLabel("NID number").fill(`1988${String(Date.now()).slice(-13)}`);
  await owner.getByLabel("Date of birth").fill("1988-07-11");
  for (const slot of ["front", "back", "selfie"]) await owner.getByTestId(`file-${slot}`).setInputFiles({ name: `${slot}.png`, mimeType: "image/png", buffer: Buffer.concat([photo, Buffer.from(slot)]) });
  await owner.getByLabel(/Kriraghor uses these documents/).check();
  await owner.getByRole("button", { name: "Send for review" }).click();
  await expect(owner.getByTestId("kyc-badge")).toContainText("Documents in review");
  const master = await masterToken(request, staff);
  const reviewer = await reviewerToken(request, staff, master);
  await approve(request, reviewer, "document", (s) => s.submittedBy.id === userId);

  // 2. Shop owner documents (trade licence and TIN).
  await expect(async () => {
    await owner.goto(`${WEB}/account/business?as=shop`);
    await expect(owner.getByTestId("business-apply")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await owner.getByRole("button", { name: "Start my shop owner application" }).click();
  const tl = owner.getByTestId("business-item-trade_license");
  await tl.getByRole("button", { name: "Send this document" }).click();
  await tl.getByLabel("Licence number").fill(`TRAD/DSCC/${run}`);
  await tl.getByLabel("Name on the licence").fill(`E2E Shop ${run} Sports`);
  await tl.getByLabel("Valid until").fill("2028-06-30");
  await owner.getByTestId("file-trade_license").setInputFiles({ name: "licence.pdf", mimeType: "application/pdf", buffer: PDF });
  await tl.getByTestId("consent-trade_license").check(); // M02, 25 Oct 2026: explicit consent before sending
  await tl.getByRole("button", { name: "Send for checking" }).click();
  await expect(tl).toContainText("Being checked");
  const tin = owner.getByTestId("business-item-tin");
  await tin.getByRole("button", { name: "Send this document" }).click();
  await tin.getByLabel(/TIN/).fill(`3${run}${run.slice(0, 5)}`);
  await owner.getByTestId("file-tin").setInputFiles({ name: "tin.pdf", mimeType: "application/pdf", buffer: Buffer.concat([PDF, Buffer.from(run)]) });
  await tin.getByTestId("consent-tin").check();
  await tin.getByRole("button", { name: "Send for checking" }).click();
  await expect(tin).toContainText("Being checked");
  await shot(owner, "business-docs");
  for (const doc of ["Trade licence", "TIN"]) await approve(request, reviewer, "document", (s) => s.submittedBy.id === userId && s.title.startsWith(doc));
  await expect(async () => {
    await owner.goto(`${WEB}/account/business?as=shop`);
    await expect(owner.getByTestId("business-status")).toContainText("approved shop owner", { timeout: 3000 });
  }).toPass({ timeout: 60_000 });

  // 3. The shop.
  await owner.goto(`${VENDOR}/vendor`);
  await expect(owner.getByTestId("shop-owner-active")).toBeVisible();
  await owner.goto(`${VENDOR}/vendor/shop`);
  const form = owner.getByTestId("shop-form");
  await form.getByTestId("shop-name").fill(`E2E Sports House ${run}`);
  await form.getByTestId("shop-area").selectOption({ label: "Dhanmondi" });
  await form.getByTestId("shop-address").fill("12 Elephant Road, Dhaka");
  await form.getByTestId("create-shop").click();
  await owner.getByTestId("submit-shop").click();
  await expect(owner.getByText("In review").first()).toBeVisible();
  await approve(request, reviewer, "shop", (s) => s.submittedBy.id === userId);
  await expect(async () => {
    await owner.reload();
    await expect(owner.getByTestId("shop-actions")).toContainText("Products", { timeout: 3000 });
  }).toPass({ timeout: 60_000 });

  // 4. Boots in three EU sizes with stock and photos; review.
  await owner.goto(`${VENDOR}/vendor/products`);
  await owner.getByTestId("add-product").click();
  const add = owner.getByTestId("add-product-form");
  await add.getByTestId("item-type").selectOption({ label: "Football · Football boots" });
  await add.getByTestId("product-title").fill(`E2E Predator Turf ${run}`);
  await add.getByTestId("product-price").fill("6500");
  await add.getByTestId("spec-stud_type").selectOption("tf");
  await add.getByTestId("create-product").click();
  await expect(owner).toHaveURL(new RegExp(`${VENDOR}/vendor/products/[0-9a-f-]{36}$`));
  const productId = owner.url().split("/").pop()!;
  const variants = owner.getByTestId("add-variant");
  for (const [size, stock] of [["42", "3"], ["43", "5"], ["44", "1"]]) {
    await variants.getByTestId("axis-eu_size").selectOption(size);
    await variants.getByTestId("opening-stock").fill(stock);
    await variants.getByTestId("add-variant-button").click();
    await expect(owner.getByTestId("variant-row")).toHaveCount(Number(size) - 41);
  }
  await owner.getByTestId("photo-input").setInputFiles([1, 2, 3].map((n) => ({ name: `boots-${n}.png`, mimeType: "image/png", buffer: Buffer.concat([photo, Buffer.from(`${run}-${n}`)]) })));
  await expect(owner.getByTestId("product-photos").locator("img")).toHaveCount(3);
  await owner.getByTestId("submit-product").click();
  await expect(owner.getByText("In review").first()).toBeVisible();
  await shot(owner, "vendor-product");
  const claim = await approve(request, reviewer, "product", (s) => s.subjectId === productId);
  expect(claim.checks.filter((c) => c.result === "fail")).toEqual([]);

  // 5. Inventory: EU 44 counted down to 0.
  await owner.goto(`${VENDOR}/vendor/inventory`);
  const row = owner.getByTestId("inventory-row").filter({ hasText: "EU 44" });
  await row.getByTestId("set-count").click();
  await owner.getByTestId("set-to").fill("0");
  await owner.getByTestId("save-count").click();
  await expect(owner.getByTestId("inventory-row").filter({ hasText: "EU 44" })).toContainText("Out, hidden from Market");
  await expect(owner.getByTestId("inventory-kpis")).toContainText("৳52,000");
  await shot(owner, "inventory");

  // 6. Buyers on kriraghor.com.
  await expect(async () => {
    await buyer.goto(`${WEB}/shop?category=football`);
    await expect(buyer.getByTestId("market-cards")).toContainText(`E2E Predator Turf ${run}`, { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await shot(buyer, "shop-list");
  await buyer.getByTestId("market-cards").getByText(`E2E Predator Turf ${run}`).click();
  await expect(buyer.getByTestId("product-title")).toHaveText(`E2E Predator Turf ${run}`);
  await expect(buyer.getByTestId("option-eu_size-44")).toBeDisabled();
  await buyer.getByTestId("option-eu_size-42").click();
  await expect(buyer.getByTestId("stock-note")).toContainText("Low stock: 3 left");
  await expect(buyer.getByTestId("product-photo")).toBeVisible();
  await shot(buyer, "product-page");
});
