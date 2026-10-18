import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { verifiedOrganiser } from "./fixtures";
import { ADMIN, API, VENDOR, WEB, masterToken, signUpByPhone, sql, testPhone } from "./helpers";

/**
 * M22 in k3d: an organiser's tournament, from the console to its branded page.
 *  1. The owner signs up on kriraghor.com; a verified organisation with an active 10% contract and the
 *     subdomain e2e-clutch-{run} is written by the fixture (the Postman run covers the review and the
 *     contract desk).
 *  2. On vendor.kriraghor.com/vendor/esports the owner opens the console and drafts a Free Fire solo
 *     tournament: ৳40 entry, places ৳100 / ৳50 / ৳25, ৳1 a kill up to 5 kills (pool ৳180).
 *  3. Sending it before the fund is paid is refused. "Fund now (৳180)" pays with bKash on the simulator;
 *     the fund escrow holds ৳180 and the draft is sent for review.
 *  4. The master approves it on the Moderation desk (the API): published with the 10% fee snapshotted.
 *  5. The branded site e2e-clutch-{run}.esports.kriraghor.localhost lists it in the organisation's colours
 *     (the wildcard ingress host and the API's CORS for organiser subdomains).
 * OTP sends: the owner's signup and the master's login.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/organiser-${name}.png`, fullPage: true });
const balance = (code: string) => Number(sql(`SELECT COALESCE(SUM(e.credit_poisha - e.debit_poisha), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = '${code}'`));

/** A datetime-local value in Dhaka time, `hours` from now. */
const dhakaLocal = (hours: number) => new Date(Date.now() + (hours + 6) * 3600_000).toISOString().slice(0, 16);

/** Claim, tick and approve the open submission of a subject on the Moderation desk. */
async function approve(request: APIRequestContext, token: string, kind: string, subjectId: string) {
  const h = { Authorization: `Bearer ${token}`, Origin: ADMIN };
  let item: { id: string } | undefined;
  await expect(async () => {
    const queue = await (await request.get(`${API}/admin/submissions?status=pending_review&kind=${kind}`, { headers: h })).json();
    item = queue.items.find((s: { subjectId: string }) => s.subjectId === subjectId);
    expect(item).toBeTruthy();
  }).toPass({ timeout: 60_000 });
  const sub = await (await request.post(`${API}/admin/submissions/${item!.id}/claim`, { headers: h })).json();
  expect(sub.checks.filter((c: { result: string }) => c.result === "fail")).toEqual([]);
  await request.put(`${API}/admin/submissions/${item!.id}/ticks`, { headers: h, data: { ticks: sub.rubric.items.map((i: { key: string }) => i.key) } });
  const d = await request.post(`${API}/admin/submissions/${item!.id}/decide`, { headers: { ...h, "Idempotency-Key": `e2e-${Date.now()}-${subjectId}` }, data: { decision: "approve" } });
  expect(d.status()).toBe(200);
}

test("an organiser drafts, funds and sends a tournament from the console; approved, it shows on the branded subdomain", async ({ browser, request }) => {
  test.setTimeout(8 * 60_000);
  const run = String(Date.now()).slice(-6);
  const owner = await (await browser.newContext()).newPage();

  // 1. The owner and the organisation (fixture).
  const { userId: ownerId } = await signUpByPhone(owner, WEB, testPhone(), `E2E Organiser ${run}`);
  const org = verifiedOrganiser(ownerId, run);

  // 2. The console: a draft with a kill cap.
  await owner.goto(`${VENDOR}/vendor/esports`);
  await owner.getByRole("link", { name: org.name }).click();
  await expect(owner).toHaveURL(new RegExp(`/vendor/esports/${org.id}$`));
  await expect(owner.getByTestId("org-console")).toBeVisible();
  await shot(owner, "dashboard");
  await owner.goto(`${VENDOR}/vendor/esports/${org.id}/tournaments`);
  await owner.getByTestId("org-new-tournament").click();
  const form = owner.getByTestId("create-tournament");
  await form.getByRole("combobox", { name: "Game", exact: true }).selectOption({ label: "Free Fire" });
  await form.getByRole("combobox", { name: "Mode", exact: true }).selectOption({ index: 1 });
  await form.getByRole("combobox", { name: "Points table", exact: true }).selectOption({ index: 1 });
  const title = `E2E Clutch Cup ${run}`;
  await form.getByLabel("Title (English)").fill(title);
  await form.getByLabel("Title (Bangla)").fill("ক্লাচ কাপ");
  await form.getByLabel("Entry fee (৳)").fill("40");
  await form.getByRole("textbox", { name: "Slots", exact: true }).fill("4");
  await form.getByLabel("Minimum entries").fill("2");
  await form.getByLabel("Per-kill reward (৳)").fill("1");
  await form.getByTestId("max-paid-kills").fill("5");
  for (const [n, v] of [["1", "100"], ["2", "50"], ["3", "25"]]) await form.getByLabel(`Prize for place ${n}`).fill(v);
  await form.getByLabel("Registration opens (Dhaka time)").fill(dhakaLocal(1));
  await form.getByRole("combobox", { name: "Map", exact: true }).selectOption({ index: 1 });
  await form.getByLabel("Starts at (Dhaka time)").fill(dhakaLocal(6));
  await form.getByLabel("Rules (Markdown)").fill("Play fair. No emulators.");
  await form.getByRole("button", { name: "Save draft" }).click();
  await expect(owner).toHaveURL(new RegExp(`/vendor/esports/${org.id}/tournaments/[0-9a-f-]{36}$`));
  const tournamentId = owner.url().split("/").pop()!;
  await expect(owner.getByTestId("org-tournament")).toContainText(title);
  expect(sql(`SELECT organisation_id || '/' || max_paid_kills FROM esports_tournaments WHERE id = '${tournamentId}'`)).toBe(`${org.id}/5`);

  // 3. Not before the fund; then fund it with bKash and send it.
  await owner.getByTestId("org-submit").click();
  await expect(owner.getByText("Fund the prize pool before sending the tournament for review")).toBeVisible();
  await expect(owner.getByTestId("fund-now")).toHaveText("Fund now (৳180)");
  await shot(owner, "fund");
  await owner.getByTestId("fund-now").click();
  await expect(owner).toHaveURL(new RegExp(`^${WEB}/pay/`));
  await owner.getByRole("radio", { name: "bKash" }).check();
  await owner.getByTestId("pay-button").click();
  await owner.getByRole("button", { name: "Pay with bKash" }).click();
  await expect(owner.getByTestId("pay-result")).toHaveAttribute("data-outcome", "paid");
  await expect.poll(() => sql(`SELECT status FROM organiser_prize_funds WHERE tournament_id = '${tournamentId}'`), { timeout: 60_000 }).toBe("funded");
  expect(balance("escrow:esports_prize_fund")).toBeGreaterThanOrEqual(18000);
  await owner.goto(`${VENDOR}/vendor/esports/${org.id}/tournaments/${tournamentId}`);
  await expect(owner.getByTestId("fund-box")).toContainText("Funded.");
  await owner.getByTestId("org-submit").click();
  await expect(owner.getByText("Sent. Kriraghor reviews it before it goes live.")).toBeVisible();
  await shot(owner, "submitted");

  // 4. The master approves it: published, the fee snapshotted.
  const master = await (await browser.newContext()).newPage();
  const token = await masterToken(request, master);
  await approve(request, token, "esports_tournament", tournamentId);
  await expect.poll(() => sql(`SELECT status || '/' || saas_fee_model || '/' || saas_fee_bps FROM esports_tournaments WHERE id = '${tournamentId}'`), { timeout: 60_000 }).toBe("scheduled/percentage/1000");

  // 5. The branded organiser site lists it.
  const site = await (await browser.newContext()).newPage();
  await site.goto(`http://${org.subdomain}.esports.kriraghor.localhost/`);
  await expect(site.getByTestId("organiser-name")).toHaveText(org.name);
  await expect(site.getByTestId("organiser-tournaments")).toContainText(title);
  await expect(site.getByTestId("organiser-page")).toContainText("Weekly scrims");
  await shot(site, "branded");
});
