import { expect, test } from "@playwright/test";
import { ADMIN, API, WEB, masterStepUp, masterToken, signUpByEmail, signUpByPhone, smsCode, testPhone } from "./helpers";

/**
 * M07 in k3d: the Phase 2 exit check, money out. Builds on the M06 pay journey:
 *  1. A payee signs up by phone and adds a bKash payout account on kriraghor.com (code to that phone).
 *  2. The master verifies it on the Finance desk (API) against the NID name.
 *  3. A payer pays a ৳200 test charge on the SSLCommerz simulator; the master releases the escrow (৳190 owed,
 *     above the ৳100 payout minimum). Clusters seeded before v5 cap test charges at ৳100: the master raises
 *     payments.test_charge_max_poisha through the settings flow first (a single-approval key).
 *  4. The master runs the daily payouts: one payout of ৳190; releases it with step-up; reveals the number
 *     (audited); marks it paid with the bKash reference.
 *  5. The payee sees it paid on /me/payouts; the payout clearing is empty and every ledger check passes.
 */
const WALLET = "01712345678";

test("payout account, payout run, release, manual send and paid; the ledger balances", async ({ browser, request }) => {
  // Five master step-ups, each in a fresh 30-second TOTP step (the API refuses a reused code).
  test.setTimeout(6 * 60_000);
  // 1. The payee and their payout account.
  const payeeCtx = await browser.newContext();
  const payee = await payeeCtx.newPage();
  const payeePhone = testPhone();
  const { userId: payeeId } = await signUpByPhone(payee, WEB, payeePhone, "E2E Payee");
  await payee.goto(`${WEB}/me/payout-account`);
  await expect(payee.getByRole("heading", { level: 1 })).toHaveText("Payout account");
  await payee.getByTestId("change-payout-account").click();
  await payee.getByLabel("Wallet number").fill(WALLET);
  await payee.getByLabel("Name on the wallet").fill("E2E Payee");
  await payee.getByLabel(/This wallet is in my own name/).check();
  await payee.getByRole("button", { name: "Send code to my phone" }).click();
  await expect(payee.getByLabel("Code from the SMS")).toBeVisible();
  // smsCode reads the newest code for the number: the payout-account code replaces the signup one.
  await payee.waitForTimeout(1500);
  await payee.getByLabel("Code from the SMS").fill(smsCode(payeePhone));
  await payee.getByRole("button", { name: "Save payout account" }).click();
  await expect(payee.getByText("Being checked")).toBeVisible();
  await expect(payee.getByText(WALLET)).toHaveCount(0);

  // 2. Finance verifies it.
  const payerCtx = await browser.newContext();
  const payer = await payerCtx.newPage();
  const token = await masterToken(request, payer);
  const admin = { Authorization: `Bearer ${token}`, Origin: ADMIN };
  const queue = await (await request.get(`${API}/admin/payout-accounts`, { headers: admin })).json();
  const mine = queue.items.find((a: { userId: string }) => a.userId === payeeId);
  expect(mine).toMatchObject({ masked: "bKash ••• 5678", status: "pending_verification" });
  expect(JSON.stringify(queue)).not.toContain(WALLET);
  const verified = await request.post(`${API}/admin/payout-accounts/${mine.id}/verify`, { headers: admin, data: { note: "E2E: name matches" } });
  expect(verified.status()).toBe(200);

  // 3. Money in: a ৳200 test charge paid on the simulator and released (৳190 to the payee).
  const cfg = await (await request.get(`${API}/admin/payments/config`, { headers: admin })).json();
  if (cfg.testChargeMax < 20000) {
    const raised = await request.post(`${API}/admin/settings/change-requests`, {
      headers: { ...admin, "X-Step-Up": await masterStepUp(request, payer, token, "settings.write") },
      data: { changes: [{ key: "payments.test_charge_max_poisha", to: 100000 }], reason: "k3d: test charges above the ৳100 payout minimum" },
    });
    expect(raised.status()).toBe(201);
    expect((await raised.json()).status).toBe("applied");
  }
  const { userId: payerId } = await signUpByEmail(payer, await payerCtx.newPage(), WEB, "E2E Payer");
  const created = await request.post(`${API}/admin/payments/test-charges`, {
    headers: { ...admin, "Idempotency-Key": `e2e-po-${Date.now()}` },
    data: { payerId, payeeId, amount: 20000, title: "E2E payout charge" },
  });
  expect(created.status()).toBe(201);
  const { payment, payUrl } = await created.json();
  await payer.goto(payUrl);
  await payer.getByRole("radio", { name: "bKash" }).check();
  await payer.getByTestId("pay-button").click();
  await payer.getByRole("button", { name: "Pay with bKash" }).click();
  await expect(payer.getByTestId("pay-result")).toHaveAttribute("data-outcome", "paid");
  const detail = await (await request.get(`${API}/admin/payments/${payment.id}`, { headers: admin })).json();
  const released = await request.post(`${API}/admin/escrow/${detail.hold.id}/release`, {
    headers: { ...admin, "X-Step-Up": await masterStepUp(request, payer, token, "escrow.manage") },
    data: { reason: "E2E payout exit check" },
  });
  expect(released.status()).toBe(200);

  // 4. The daily run, release, reveal and paid.
  const run = await request.post(`${API}/admin/payout-batches/run`, { headers: admin, data: { schedule: "daily" } });
  expect(run.status()).toBe(201);
  const list = await (await request.get(`${API}/admin/payouts?status=scheduled&payeeId=${payeeId}`, { headers: admin })).json();
  expect(list.items).toHaveLength(1);
  const payout = list.items[0];
  expect(payout).toMatchObject({ amount: 19000, gross: 20000, deductions: 1000, account: { masked: "bKash ••• 5678" } });

  const rel = await request.post(`${API}/admin/payouts/${payout.id}/release`, {
    headers: { ...admin, "Idempotency-Key": `e2e-rel-${Date.now()}`, "X-Step-Up": await masterStepUp(request, payer, token, "payout.approve") },
  });
  expect(rel.status()).toBe(200);
  expect((await rel.json()).status).toBe("processing");
  const shown = await request.post(`${API}/admin/payouts/${payout.id}/reveal`, { headers: { ...admin, "X-Step-Up": await masterStepUp(request, payer, token, "payout.approve") } });
  expect(shown.status()).toBe(200);
  expect(shown.headers()["cache-control"]).toBe("no-store");
  expect(await shown.json()).toMatchObject({ number: WALLET, amount: 19000 });
  const paid = await request.post(`${API}/admin/payouts/${payout.id}/mark-paid`, { headers: { ...admin, "Idempotency-Key": `e2e-mp-${Date.now()}` }, data: { reference: "BKE2E0001" } });
  expect(paid.status()).toBe(200);
  expect(await paid.json()).toMatchObject({ status: "paid", providerRef: "BKE2E0001" });

  // This payout went in and out of payout_clearing (release, then paid); the invariant below checks the account as a whole.
  const po = await (await request.get(`${API}/admin/payouts/${payout.id}`, { headers: admin })).json();
  expect(po).toMatchObject({ status: "paid", reveals: 1 });
  expect(po.ledger).toHaveLength(2);
  expect((await (await request.get(`${API}/admin/ledger/trial-balance`, { headers: admin })).json()).difference).toBe(0);
  const checks = await (await request.get(`${API}/admin/ledger/invariants`, { headers: admin })).json();
  expect(checks.ok).toBe(true);
  expect(checks.checks.map((c: { name: string }) => c.name)).toContain("payout_clearing_matches");

  // 5. The payee sees it.
  await payee.goto(`${WEB}/me/payouts`);
  await expect(payee.getByTestId("my-payouts")).toContainText(payout.code);
  await expect(payee.getByTestId("my-payouts")).toContainText("Paid");
  await expect(payee.getByTestId("my-payouts")).toContainText("bKash ••• 5678");
  await expect(payee.getByTestId("payout-summary")).toContainText("৳190");
  await payeeCtx.close();
  await payerCtx.close();
});
