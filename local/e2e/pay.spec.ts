import { expect, test } from "@playwright/test";
import { ADMIN, API, WEB, masterStepUp, masterToken, signUpByEmail } from "./helpers";

/**
 * M06 in k3d (Phase 2, the money half of the exit check), through the SSLCommerz simulator:
 *  1. A payer and a payee sign up on kriraghor.com.
 *  2. The master creates a ৳100 test charge (API, admin session).
 *  3. The payer opens the pay link, picks bKash, pays on the gateway page and lands on "Payment confirmed".
 *  4. The master releases the hold with step-up: the payee is owed ৳95, the platform keeps ৳5, the ledger balances.
 *  5. The payer sees the payment under My payments.
 */
test("pay a test charge into escrow, release it, and the ledger balances", async ({ browser, request }) => {
  const payerCtx = await browser.newContext();
  const payer = await payerCtx.newPage();
  const helper = await payerCtx.newPage();
  const { userId: payerId } = await signUpByEmail(payer, helper, WEB, "E2E Payer");

  const payeeCtx = await browser.newContext();
  const payeePage = await payeeCtx.newPage();
  const { userId: payeeId } = await signUpByEmail(payeePage, await payeeCtx.newPage(), WEB, "E2E Payee");
  await payeeCtx.close();

  const token = await masterToken(request, payer);
  const admin = { Authorization: `Bearer ${token}`, Origin: ADMIN };
  const created = await request.post(`${API}/admin/payments/test-charges`, {
    headers: { ...admin, "Idempotency-Key": `e2e-${Date.now()}` },
    data: { payerId, payeeId, amount: 10000, title: "E2E test charge" },
  });
  expect(created.status()).toBe(201);
  const { payment, payUrl } = await created.json();
  expect(payUrl).toBe(`${WEB}/pay/${payment.id}`);

  // The payer pays with bKash on the gateway (simulator) page.
  await payer.goto(payUrl);
  await expect(payer.getByTestId("pay-amount")).toHaveText("৳100");
  await expect(payer.getByRole("heading", { level: 1 })).toHaveText("E2E test charge");
  await payer.getByRole("radio", { name: "bKash" }).check();
  await payer.getByTestId("pay-button").click();
  await expect(payer).toHaveURL(/api\.kriraghor\.localhost\/dev\/sslcommerz\/pay\//);
  await expect(payer.getByText("SSLCommerz simulator")).toBeVisible();
  await payer.getByRole("button", { name: "Pay with bKash" }).click();

  await expect(payer).toHaveURL(`${WEB}/pay/${payment.id}/result`);
  await expect(payer.getByTestId("pay-result")).toHaveAttribute("data-outcome", "paid");
  await expect(payer.getByRole("heading", { level: 1 })).toHaveText("৳100 paid");
  await expect(payer.getByText(payment.code)).toBeVisible();

  // Finance: the money is in escrow; the master releases it with step-up.
  const detail = await (await request.get(`${API}/admin/payments/${payment.id}`, { headers: admin })).json();
  expect(detail).toMatchObject({ status: "succeeded", hold: { status: "holding", available: 10000 } });
  const stepUp = await masterStepUp(request, payer, token, "escrow.manage");
  const released = await request.post(`${API}/admin/escrow/${detail.hold.id}/release`, { headers: { ...admin, "X-Step-Up": stepUp }, data: { reason: "E2E exit check" } });
  expect(released.status()).toBe(200);
  expect(await released.json()).toMatchObject({ gross: 10000, fee: 500, net: 9500 });

  const accounts = await (await request.get(`${API}/admin/ledger/accounts?code=${payeeId}`, { headers: admin })).json();
  expect(accounts.items).toEqual([expect.objectContaining({ code: `payable:user:${payeeId}`, balance: 9500 })]);
  const tb = await (await request.get(`${API}/admin/ledger/trial-balance`, { headers: admin })).json();
  expect(tb.difference).toBe(0);
  const checks = await (await request.get(`${API}/admin/ledger/invariants`, { headers: admin })).json();
  expect(checks.ok).toBe(true);

  // The payer's history.
  await payer.goto(`${WEB}/me/payments`);
  await expect(payer.getByTestId("my-payments")).toContainText(payment.code);
  await expect(payer.getByTestId("my-payments")).toContainText("Paid");
  await payerCtx.close();
});
