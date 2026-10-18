import { expect, test, type Page } from "@playwright/test";
import { liveBigEvent } from "./fixtures";
import { ADMIN, API, ESPORTS, WEB, masterToken, signUpByPhone, testPhone } from "./helpers";

/**
 * M23 in k3d: a big event page, live.
 *  1. A published, featured event running now (fixture): a live YouTube stream, a title sponsor and an
 *     open poll. The esports home leads with it; a guest sees the embedded player (youtube-nocookie,
 *     sandboxed) and "Presented by"; the page carries the frame-src CSP.
 *  2. A member signs up on kriraghor.com and, on esports (same account), follows the event and votes:
 *     the poll shows the result (100%) and "your vote".
 *  3. Staff post an announcement through the admin API: the member's open page shows it without a
 *     reload (the event room ping, then a re-fetch).
 * OTP sends: the member's signup and the master's login. Live standings over the socket are covered by
 * the M21 esports spec; the qualifier → final rules by the backend tests and the Postman run.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/events-${name}.png`, fullPage: true });

test("a big event page: embedded stream, follow, a poll vote, and an announcement arriving live", async ({ browser, request }) => {
  test.setTimeout(6 * 60_000);
  const run = String(Date.now()).slice(-6);
  const ev = liveBigEvent(run);

  // 1. The home hero and the page as a guest.
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`${ESPORTS}/`);
  await expect(guest.getByTestId("hero-event")).toContainText(ev.title);
  const res = await guest.goto(`${ESPORTS}/e/${ev.slug}`);
  expect(res?.headers()["content-security-policy"]).toContain("frame-src https://www.youtube-nocookie.com");
  await expect(guest.getByTestId("event-title")).toHaveText(ev.title);
  await expect(guest.getByText("Presented by E2E Walton")).toBeVisible();
  const frame = guest.getByTestId("stream-iframe");
  await expect(frame).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);
  await expect(frame).toHaveAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  await shot(guest, "guest");

  // 2. A member follows and votes.
  const member = await (await browser.newContext()).newPage();
  await signUpByPhone(member, WEB, testPhone(), `E2E Fan ${run}`);
  await member.goto(`${ESPORTS}/e/${ev.slug}`);
  await member.getByTestId("event-follow").click();
  await expect(member.getByTestId("event-follow")).toHaveText(/Following · 1/);
  const poll = member.getByTestId("event-poll");
  await poll.getByRole("button", { name: "Team Alpha" }).click();
  await expect(poll).toContainText("100%");
  await expect(poll).toContainText("your vote");
  await shot(member, "voted");

  // 3. Staff announce; the open page shows it without a reload.
  const master = await (await browser.newContext()).newPage();
  const token = await masterToken(request, master);
  const text = `The final starts in 10 minutes (${run})`;
  const posted = await request.post(`${API}/admin/esports/events/${ev.id}/feed`, { headers: { Authorization: `Bearer ${token}`, Origin: ADMIN }, data: { textEn: text, textBn: `ফাইনাল ১০ মিনিটে (${run})` } });
  expect(posted.status()).toBe(201);
  await expect(member.getByTestId("event-feed")).toContainText(text, { timeout: 20_000 });
  await shot(member, "announced");
});
