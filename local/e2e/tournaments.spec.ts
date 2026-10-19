import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { nidVerified, verifiedSportsOrg } from "./fixtures";
import { API, VENDOR, WEB, masterToken, signUpByPhone, sql, testPhone } from "./helpers";

/**
 * M14 in k3d: a paid badminton double league for two teams, end to end (4 OTP sends: the organiser,
 * two captains and the master's login).
 *  1. A verified sports organisation (fixture) creates the tournament in the console on
 *     vendor.kriraghor.com and submits it; the master approves it on the review API.
 *  2. Two captains (NID fixture) create a badminton team on kriraghor.com, register it with a squad of
 *     one and pay ৳500 with bKash on the simulator: the money waits in escrow.
 *  3. The organiser approves both, closes registration, makes a random draw, generates and publishes
 *     the fixtures, and enters the first result: half of each entry less 5% (৳237.50 each) goes to the
 *     organiser's payable; the public hub shows the table.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/tournaments-${name}.png`, fullPage: true });
const balance = (code: string) => Number(sql(`SELECT COALESCE(SUM(e.credit_poisha - e.debit_poisha), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = '${code}'`));

async function approve(request: APIRequestContext, page: Page, tournamentId: string) {
  const token = await masterToken(request, page);
  const auth = { Authorization: `Bearer ${token}` };
  const sub = sql(`SELECT id FROM submissions WHERE kind = 'tournament' AND subject_id = '${tournamentId}' AND status = 'pending_review'`);
  expect(sub).not.toBe("");
  const ticks = JSON.parse(sql(`SELECT r.items FROM review_rubrics r JOIN submissions s ON s.rubric_id = r.id WHERE s.id = '${sub}'`)).map((i: { key: string }) => i.key);
  expect((await request.post(`${API}/admin/submissions/${sub}/claim`, { headers: auth })).ok()).toBeTruthy();
  expect((await request.put(`${API}/admin/submissions/${sub}/ticks`, { headers: auth, data: { ticks } })).ok()).toBeTruthy();
  const d = await request.post(`${API}/admin/submissions/${sub}/decide`, { headers: { ...auth, "Idempotency-Key": `e2e-${Date.now()}` }, data: { decision: "approve" } });
  expect(d.ok()).toBeTruthy();
}

async function captainWithTeam(page: Page, name: string) {
  const { userId } = await signUpByPhone(page, WEB, testPhone(), name);
  nidVerified(userId);
  await page.goto(`${WEB}/me/teams`);
  const create = page.getByTestId("create-team");
  await create.getByLabel("Sport").selectOption("badminton");
  await create.getByLabel("Team name").fill(`${name.split(" ")[0]} Smashers`);
  await create.getByRole("button", { name: "Create team" }).click();
  await expect(page.getByTestId("team-name")).toHaveText(`${name.split(" ")[0]} Smashers`);
  return userId;
}

async function registerAndPay(page: Page, slug: string) {
  await page.goto(`${WEB}/events/${slug}/register`);
  await page.getByTestId("pick-team").first().check();
  await page.getByTestId("pick-player").first().check();
  await page.getByTestId("accept-rules").check();
  await expect(page.getByTestId("register-submit")).toHaveText("Pay ৳500");
  await page.getByTestId("register-submit").click();
  await expect(page).toHaveURL(new RegExp(`^${WEB}/pay/`));
  await page.getByRole("radio", { name: "bKash" }).check();
  await page.getByTestId("pay-button").click();
  await page.getByRole("button", { name: "Pay with bKash" }).click();
  await expect(page.getByTestId("pay-result")).toHaveAttribute("data-outcome", "paid");
}

test("an organiser runs a paid badminton league: review, entries in escrow, draw, fixtures, a result and tranche 1", async ({ browser, request }) => {
  test.setTimeout(10 * 60_000);
  const run = String(Date.now()).slice(-6);
  const organiser = await (await browser.newContext()).newPage();
  const capA = await (await browser.newContext()).newPage();
  const capB = await (await browser.newContext()).newPage();
  const visitor = await (await browser.newContext()).newPage();

  // 1. The organisation (fixture) and the tournament from the console.
  const { userId: ownerId } = await signUpByPhone(organiser, WEB, testPhone(), `E2E Organiser ${run}`);
  const org = verifiedSportsOrg(ownerId, run);
  const name = `E2E Badminton League ${run}`;
  await organiser.goto(`${VENDOR}/vendor/events`);
  await expect(organiser).toHaveURL(`${VENDOR}/vendor/events/${org.id}`);
  await organiser.getByTestId("new-tournament").click();
  const form = organiser.getByTestId("tournament-form");
  await form.getByTestId("tf-sport").selectOption("badminton");
  await form.getByTestId("tf-name").fill(name);
  await form.getByTestId("tf-format").selectOption("double_league");
  await form.getByTestId("tf-min").fill("2");
  await form.getByTestId("tf-max").fill("2");
  await form.getByTestId("tf-squad-min").fill("1");
  await form.getByTestId("tf-squad-max").fill("2");
  await form.getByTestId("tf-fee").fill("500");
  await form.getByTestId("tf-venue").fill("Mirpur Indoor Stadium");
  await form.getByTestId("tf-area").selectOption({ index: 1 });
  await shot(organiser, "wizard");
  await form.getByTestId("tf-create").click();
  await expect(organiser.getByTestId("console-name")).toHaveText(name);
  const tournamentId = organiser.url().split("/").pop()!;
  await organiser.getByTestId("console-submit").click();
  await expect(organiser.getByTestId("console-status")).toHaveText("In review");
  await approve(request, organiser, tournamentId);
  const slug = sql(`SELECT slug FROM tournaments WHERE id = '${tournamentId}'`);
  await organiser.reload();
  await expect(organiser.getByTestId("console-status")).toHaveText("Taking teams");

  // 2. Two captains register and pay.
  await captainWithTeam(capA, `Shuvo Rahman ${run}`);
  await captainWithTeam(capB, `Arif Hossain ${run}`);
  await visitor.goto(`${WEB}/events`);
  await expect(visitor.getByTestId("tournament-list")).toContainText(name);
  await registerAndPay(capA, slug);
  await registerAndPay(capB, slug);
  await shot(capB, "paid");
  await expect.poll(() => sql(`SELECT count(*) FROM registrations WHERE tournament_id = '${tournamentId}' AND status = 'pending_approval'`), { timeout: 60_000 }).toBe("2");
  expect(sql(`SELECT count(*) || '/' || sum(held_poisha) FROM escrow_holds WHERE purpose = 'tournament_entry' AND group_ref = '${tournamentId}'`)).toBe("2/100000");

  // 3. Approve, close, draw, fixtures, the first result.
  await organiser.getByTestId("console-tab-teams").click();
  for (const left of [1, 0]) {
    await organiser.getByTestId("reg-approve").first().click();
    await expect(organiser.getByTestId("reg-approve")).toHaveCount(left);
  }
  await organiser.getByTestId("console-tab-overview").click();
  await organiser.getByTestId("console-close").click();
  await expect(organiser.getByTestId("console-status")).toHaveText("Registration closed");
  await organiser.getByTestId("console-tab-fixtures").click();
  await organiser.getByTestId("draw-confirm").click();
  await organiser.getByTestId("fixtures-generate").click();
  await organiser.getByTestId("fixtures-publish").click();
  await expect(organiser.getByTestId("console-match")).toHaveCount(2);
  await shot(organiser, "fixtures");
  await organiser.getByTestId("match-result-open").first().click();
  await organiser.getByTestId("result-sets").fill("21-15, 21-17");
  await organiser.getByTestId("result-save").click();
  await expect.poll(() => balance(`payable:user:${ownerId}`), { timeout: 60_000 }).toBe(2 * (25000 - 1250));
  await organiser.getByTestId("console-tab-overview").click();
  await expect(organiser.getByTestId("console-status")).toHaveText("Live");
  await shot(organiser, "overview");

  // The public hub shows the table and no personal data.
  await visitor.goto(`${WEB}/events/${slug}?tab=standings`);
  await expect(visitor.getByTestId("standings-row")).toHaveCount(2);
  await expect(visitor.getByTestId("hub-status")).toHaveText("Live");
  await shot(visitor, "hub");
  expect(await visitor.locator("main").innerText()).not.toMatch(/gender|01\d{9}/i);
});
