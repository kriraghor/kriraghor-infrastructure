import { expect, test, type Page } from "@playwright/test";
import { liveHireProfile, moveHireJob } from "./fixtures";
import { WEB, signUpByPhone, sql, testPhone } from "./helpers";

/**
 * M11 in k3d: a hire end to end, on kriraghor.com.
 *  1. A pro with a live T20 scorer profile in Dhanmondi (fixture; the Postman run covers the
 *     credential and the review), and a manager with a verified phone.
 *  2. The manager finds the scorer on /hiring and asks for a T20 night match in Mirpur four days out.
 *     The server quotes ৳3,300: ৳2,500 + 20% night (৳500) + travel north (৳300).
 *  3. The pro accepts on the pro desk (/pro/requests, all checks pass). In the thread a phone number
 *     is refused before payment; a plain message goes through.
 *  4. The manager pays with bKash on the simulator: one payment, one escrow hold for the job, and
 *     both phones now show.
 *  5. Match day (the job moved to 20 minutes from now): the pro checks in (late), starts and marks
 *     it complete with the result; the manager confirms. The pro's payable is ৳2,970 (10% fee).
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/hire-${name}.png`, fullPage: true });
const balance = (code: string) => Number(sql(`SELECT COALESCE(SUM(e.credit_poisha - e.debit_poisha), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = '${code}'`));

test("a manager hires a scorer, pays into escrow, and the scorer is paid ৳2,970 after the match is confirmed", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const run = String(Date.now()).slice(-6);
  const pro = await (await browser.newContext()).newPage();
  const manager = await (await browser.newContext()).newPage();

  // 1. The scorer (fixture) and the manager.
  const proPhone = testPhone();
  const { userId: proId } = await signUpByPhone(pro, WEB, proPhone, `E2E Scorer ${run}`);
  const { slug } = liveHireProfile(proId, run);
  await signUpByPhone(manager, WEB, testPhone(), `E2E Manager ${run}`);

  // 2. Find and request.
  await manager.goto(`${WEB}/hiring?category=officials&unit=match`);
  await expect(manager.getByTestId("hire-cards")).toContainText(`E2E league scorer ${run}`);
  await shot(manager, "directory");
  await manager.goto(`${WEB}/hiring/${slug}`);
  await expect(manager.getByTestId("hire-rates")).toContainText("৳2,500");
  const form = manager.getByTestId("hire-request-form");
  await form.getByLabel("Format").selectOption("T20");
  await form.getByTestId("hire-venue-area").selectOption({ label: "Mirpur" });
  await form.getByTestId("hire-venue").fill("Mirpur Turf 10, Section 10");
  await expect(form.getByTestId("hire-quote-total")).toHaveText("৳3,300");
  await shot(manager, "request-form");
  await form.getByTestId("hire-send").click();
  await expect(manager).toHaveURL(new RegExp(`^${WEB}/me/hire/HR-`));
  const code = manager.url().split("/").pop()!;
  await expect(manager.getByTestId("hire-request-status")).toHaveText("Waiting for a reply");

  // 3. The pro accepts; the thread refuses a phone number before payment.
  await expect(async () => {
    await pro.goto(`${WEB}/pro/requests`);
    await expect(pro.getByTestId("pro-request").first()).toContainText(code, { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  const req = pro.getByTestId("pro-request").first();
  await expect(req.getByTestId("pro-checks")).not.toContainText("✕");
  await shot(pro, "pro-requests");
  await req.getByTestId("pro-accept").click();
  await expect(req).toContainText("Accepted, to pay");
  await manager.reload();
  await expect(manager.getByTestId("hire-pay-box")).toBeVisible();
  await expect(manager.getByTestId("hire-other-phone")).toContainText("Shows once the request is paid");
  await manager.getByTestId("hire-message-input").fill("Call me on 01711 000 111");
  await manager.getByTestId("hire-message-send").click();
  await expect(manager.getByTestId("hire-thread")).toContainText("contact details show once the request is paid");
  await manager.getByTestId("hire-message-input").fill("Toss at 7:15, please come 30 minutes early");
  await manager.getByTestId("hire-message-send").click();
  await expect(manager.getByTestId("hire-message").last()).toContainText("Toss at 7:15");
  await shot(manager, "accepted-unpaid");

  // 4. Pay into escrow; the phones show.
  await manager.getByTestId("hire-pay").click();
  await expect(manager).toHaveURL(new RegExp(`^${WEB}/pay/`));
  await manager.getByRole("radio", { name: "bKash" }).check();
  await manager.getByTestId("pay-button").click();
  await manager.getByRole("button", { name: "Pay with bKash" }).click();
  await expect(manager.getByTestId("pay-result")).toHaveAttribute("data-outcome", "paid");
  const requestId = sql(`SELECT id FROM hire_requests WHERE code = '${code}'`);
  expect(sql(`SELECT count(*) || '/' || sum(held_poisha) FROM escrow_holds WHERE payment_id = (SELECT payment_id FROM hire_requests WHERE id = '${requestId}')`)).toBe("1/330000");
  await expect(async () => {
    await manager.goto(`${WEB}/me/hire/${code}`);
    await expect(manager.getByTestId("hire-request-status")).toHaveText("Confirmed", { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await expect(manager.getByTestId("hire-other-phone")).toContainText(proPhone.slice(-8));
  await shot(manager, "confirmed");

  // 5. Match day: check in, start, complete; the manager confirms.
  const jobId = sql(`SELECT id FROM hire_jobs WHERE request_id = '${requestId}'`);
  moveHireJob(jobId, 20);
  await pro.goto(`${WEB}/pro/jobs`);
  const job = pro.getByTestId("hire-job").first();
  await job.getByTestId("hire-check-in").click();
  await expect(job.getByTestId("hire-job-status")).toHaveText("Checked in · late");
  moveHireJob(jobId, 10);
  await pro.reload();
  await job.getByTestId("hire-start").click();
  await expect(job.getByTestId("hire-job-status")).toHaveText("Live · late");
  await job.getByTestId("hire-complete").click();
  await job.getByTestId("hire-result").fill("Dhanmondi XI won by 6 wickets");
  await job.getByTestId("hire-complete-send").click();
  await expect(job.getByTestId("hire-job-status")).toHaveText("Marked complete · late");
  await shot(pro, "pro-job-complete");

  await manager.reload();
  const mine = manager.getByTestId("hire-job").first();
  await expect(mine).toContainText("Dhanmondi XI won by 6 wickets");
  await mine.getByTestId("hire-confirm").click();
  await expect(mine.getByTestId("hire-job-status")).toHaveText("Paid · late");
  await shot(manager, "job-paid");
  await expect.poll(() => balance(`payable:user:${proId}`)).toBe(297000);
  await expect.poll(() => sql(`SELECT status FROM hire_requests WHERE id = '${requestId}'`)).toBe("completed");
});
