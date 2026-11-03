import { expect, test, type Page } from "@playwright/test";
import { verifiedOrganiser } from "./fixtures";
import { API, ADMIN, VENDOR, WEB, masterToken, signUpByPhone, testPhone } from "./helpers";

/**
 * M22 in k3d, switched off (product owner, 21 Oct 2026: esports is organised by Kriraghor only;
 * `esports.external_organisers_enabled` is false by default). An esports organisation that already
 * exists (written by the fixture with a branded subdomain) gets nothing:
 *  1. vendor.kriraghor.com/vendor/esports sends its owner to the business home;
 *  2. its branded subdomain shows no organiser page, and the public branded-page API answers 404;
 *  3. staff cannot sign a new esports contract (409 ESPORTS_ORGANISERS_CLOSED).
 * With the switch on, the whole organiser flow is covered by the backend's Postman run (run-m22) and
 * jest suite. OTP sends: the owner's signup and the master's login.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/organiser-${name}.png`, fullPage: true });

test("outside esports organisers are switched off: no console, no branded page, no new contract", async ({ browser, request }) => {
  test.setTimeout(4 * 60_000);
  const run = String(Date.now()).slice(-6);
  const owner = await (await browser.newContext()).newPage();
  const { userId: ownerId } = await signUpByPhone(owner, WEB, testPhone(), `E2E Organiser ${run}`);
  const org = verifiedOrganiser(ownerId, run);

  // 1. The esports console is gone: the owner lands on the business home.
  await owner.goto(`${VENDOR}/vendor/esports`);
  await expect(owner).toHaveURL(/\/vendor\/?$/);
  await owner.goto(`${VENDOR}/vendor/esports/${org.id}`);
  await expect(owner).toHaveURL(/\/vendor\/?$/);
  await shot(owner, "redirected");

  // 2. No branded organiser page, on the site or in the API.
  const site = await (await browser.newContext()).newPage();
  await site.goto(`http://${org.subdomain}.esports.kriraghor.localhost/`);
  await expect(site.getByTestId("organiser-page")).toHaveCount(0);
  expect((await request.get(`${API}/esports/organisers/${org.subdomain}`)).status()).toBe(404);

  // 3. Staff cannot sign a new esports contract.
  const master = await (await browser.newContext()).newPage();
  const token = await masterToken(request, master);
  const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const r = await request.post(`${API}/admin/organisers/${org.id}/contracts`, {
    headers: { Authorization: `Bearer ${token}`, Origin: ADMIN },
    data: { model: "percentage", billingCycle: "per_tournament", startsOn: today },
  });
  expect(r.status()).toBe(409);
  expect((await r.json()).code).toBe("ESPORTS_ORGANISERS_CLOSED");
});
