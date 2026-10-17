import { expect, test, type Page } from "@playwright/test";
import { liveShopWithBoots } from "./fixtures";
import { VENDOR, WEB, signUpByPhone, sql, testPhone } from "./helpers";

/**
 * M13 in k3d: a shop order end to end.
 *  1. A shop owner with a live shop and turf boots at ৳6,500 in EU 42 (fixture; the M12 spec covers
 *     the listing flow), and a buyer with a verified phone.
 *  2. On kriraghor.com the buyer adds the boots to the cart, checks out to Dhanmondi (৳80 delivery,
 *     total ৳6,580) and pays with bKash on the simulator. One payment, one escrow hold for the shop.
 *  3. On vendor.kriraghor.com the owner sees the area only, accepts (the address shows), ships with
 *     Pathao and a tracking number, and marks it delivered.
 *  4. The buyer confirms "I received it": the shop's payable is ৳6,255 (৳6,500 + ৳80 − ৳325, the 5%
 *     commission on the items only) and the order is complete.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/orders-${name}.png`, fullPage: true });
const balance = (code: string) => Number(sql(`SELECT COALESCE(SUM(e.credit_poisha - e.debit_poisha), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = '${code}'`));

test("a buyer orders boots, the shop ships them, and the shop is paid ৳6,255 after the buyer confirms", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const run = String(Date.now()).slice(-6);
  const owner = await (await browser.newContext()).newPage();
  const buyer = await (await browser.newContext()).newPage();

  // 1. The shop (fixture) and the buyer.
  const { userId: ownerId } = await signUpByPhone(owner, WEB, testPhone(), `E2E Boot Room ${run}`);
  const { slug, variant } = liveShopWithBoots(ownerId, run);
  const buyerPhone = testPhone();
  await signUpByPhone(buyer, WEB, buyerPhone, `E2E Buyer ${run}`);

  // 2. Cart, checkout, pay.
  await buyer.goto(`${WEB}/shop/p/${slug}`);
  await buyer.getByTestId("option-eu_size-42").click();
  await buyer.getByTestId("add-to-cart").click();
  await expect(buyer.getByTestId("added")).toBeVisible();
  await expect(buyer.getByTestId("cart-count")).toHaveText("1");
  await buyer.getByTestId("cart-link").click();
  await expect(buyer.getByTestId("cart-line")).toContainText(`E2E Turf Boots ${run}`);
  await expect(buyer.getByTestId("cart-items")).toHaveText("৳6,500");
  await shot(buyer, "cart");
  await buyer.getByTestId("go-checkout").click();
  await buyer.getByLabel("Name", { exact: true }).fill(`E2E Buyer ${run}`);
  await buyer.getByLabel("Mobile number").fill(buyerPhone);
  await buyer.getByTestId("ship-area").selectOption({ label: "Dhanmondi" });
  await buyer.getByLabel("Address", { exact: true }).fill("House 12, Road 5, Dhanmondi");
  await expect(buyer.getByTestId("order-total")).toHaveText("৳6,580");
  await shot(buyer, "checkout");
  await buyer.getByTestId("place-order").click();
  await expect(buyer).toHaveURL(new RegExp(`^${WEB}/pay/`));
  await buyer.getByRole("radio", { name: "bKash" }).check();
  await buyer.getByTestId("pay-button").click();
  await buyer.getByRole("button", { name: "Pay with bKash" }).click();
  await expect(buyer.getByTestId("pay-result")).toHaveAttribute("data-outcome", "paid");
  const orderId = sql(`SELECT o.id FROM orders o JOIN sub_orders s ON s.order_id = o.id JOIN order_items i ON i.sub_order_id = s.id WHERE i.variant_id = '${variant}' ORDER BY o.created_at DESC LIMIT 1`);
  expect(sql(`SELECT count(*) || '/' || sum(held_poisha) FROM escrow_holds WHERE payment_id = (SELECT payment_id FROM orders WHERE id = '${orderId}')`)).toBe("1/658000");
  expect(sql(`SELECT held FROM product_variants WHERE id = '${variant}'`)).toBe("1");
  await buyer.getByTestId("back-to-order").click();
  await expect(buyer.getByTestId("order-row").first()).toContainText("Placed");
  await shot(buyer, "my-orders");

  // 3. The shop fulfils on vendor.kriraghor.com.
  await expect(async () => {
    await owner.goto(`${VENDOR}/vendor/orders`);
    await expect(owner.getByTestId("order-row").first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await owner.getByTestId("order-row").first().click();
  const panel = owner.getByTestId("order-panel");
  await expect(panel.getByTestId("ship-to")).toContainText("show once you accept");
  await expect(panel.getByTestId("order-net")).toHaveText("৳6,255");
  await panel.getByTestId("accept-order").click();
  await expect(panel.getByTestId("ship-to")).toContainText("House 12, Road 5, Dhanmondi");
  await shot(owner, "vendor-accepted");
  await panel.getByTestId("courier").fill("Pathao");
  await panel.getByTestId("tracking").fill(`PTH-E2E-${run}`);
  await panel.getByTestId("ship-order").click();
  await expect(panel).toContainText("Shipped");
  expect(sql(`SELECT on_hand || '/' || held FROM product_variants WHERE id = '${variant}'`)).toBe("4/0");
  await panel.getByTestId("mark-delivered").click();
  await expect(panel).toContainText("Waiting for the buyer");
  await shot(owner, "vendor-delivered");

  // 4. The buyer confirms; the shop is paid ৳6,255.
  await buyer.goto(`${WEB}/me/orders`);
  await buyer.getByTestId("order-row").first().click();
  const sub = buyer.getByTestId("sub-order");
  await expect(sub.getByTestId("sub-status")).toHaveText("Delivered");
  await expect(sub.getByTestId("sub-tracking")).toContainText(`PTH-E2E-${run}`);
  await sub.getByTestId("received").click();
  await expect(sub.getByTestId("sub-status")).toHaveText("Completed");
  await shot(buyer, "order-completed");
  await expect.poll(() => balance(`payable:user:${ownerId}`)).toBe(625500);
  expect(sql(`SELECT status FROM orders WHERE id = '${orderId}'`)).toBe("completed");
});
