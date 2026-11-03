import { expect, test, type Page } from "@playwright/test";
import { tournamentPost } from "./fixtures";
import { WEB, signUpByPhone, testPhone } from "./helpers";

/**
 * M26 in k3d: the tournament feed (ADR-008). Nobody organises sports tournaments on Kriraghor.
 *  1. A member has a post (fixture; the form is covered by the backend's Postman run and the local
 *     browser run), and it shows on /tournaments, signed out, with the line that Kriraghor doesn't run it.
 *  2. A player finds it with a filter in the URL, comments (a phone number is refused) and messages
 *     the organiser (a phone number is fine there).
 *  3. The organiser reads it and replies; the player sees the reply.
 *  4. The old /events pages land on the feed.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/feed-${name}.png`, fullPage: true });
const visible = (page: Page, id: string) => page.locator(`[data-testid="${id}"]:visible`);

test("a tournament is posted, found, discussed and messaged about, and no money moves", async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const run = String(Date.now()).slice(-6);
  const organiser = await (await browser.newContext()).newPage();
  const player = await (await browser.newContext()).newPage();
  const { userId } = await signUpByPhone(organiser, WEB, testPhone(), `E2E Organiser ${run}`);
  await signUpByPhone(player, WEB, testPhone(), `E2E Player ${run}`);

  // 1. The post.
  const { slug, title } = tournamentPost(userId, run);
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`${WEB}/tournaments`);
  await expect(visible(guest, "post-list")).toContainText(title);
  await guest.goto(`${WEB}/tournaments/${slug}`);
  await expect(visible(guest, "post-disclaimer")).toContainText("doesn't organise");
  await shot(guest, "post");

  // 2. Find it, comment, message.
  await player.goto(`${WEB}/tournaments?fee=paid&q=${encodeURIComponent(title)}`);
  await visible(player, "post-card").first().click();
  await visible(player, "comment-body").fill("Call me on 01712345678");
  await visible(player, "comment-send").click();
  await expect(player.getByText("Phone numbers, emails and links").first()).toBeVisible();
  await visible(player, "comment-body").fill("Is it open to school teams?");
  await visible(player, "comment-send").click();
  await expect(visible(player, "post-comments")).toContainText("school teams");
  await visible(player, "post-message").click();
  await expect(player).toHaveURL(/\/me\/tournaments\?thread=/);
  await visible(player, "thread-body").fill("My number is 01712345678, please call");
  await visible(player, "thread-send").click();
  await expect(visible(player, "thread-messages")).toContainText("01712345678");

  // 3. The organiser replies.
  await organiser.goto(`${WEB}/me/tournaments?tab=messages`);
  await visible(organiser, "thread-row").first().click();
  await visible(organiser, "thread-body").fill("Thanks, I will call tonight");
  await visible(organiser, "thread-send").click();
  await expect(visible(organiser, "thread-messages")).toContainText("Thanks, I will call tonight");
  await shot(organiser, "messages");
  await player.reload();
  await expect(visible(player, "thread-messages")).toContainText("Thanks, I will call tonight");

  // 4. Old links.
  await guest.goto(`${WEB}/events`);
  await expect(guest).toHaveURL(`${WEB}/tournaments`);
  await guest.goto(`${WEB}/events/old-cup/register`);
  await expect(guest).toHaveURL(`${WEB}/tournaments`);
});
