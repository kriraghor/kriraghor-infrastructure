import { expect, test, type Page } from "@playwright/test";
import { nidVerified } from "./fixtures";
import { WEB, signUpByPhone, sql, testPhone } from "./helpers";

/**
 * M16 in k3d: a team from an invite by phone (2 OTP sends).
 *  1. A captain signs up by phone and creates a football team on /me/teams.
 *  2. They invite a number with no account: the page shows a share link (no SMS goes to that number).
 *  3. The second person signs up with that number, opens the link and joins.
 *  4. The captain sees both members with the NID badge (after the second member's NID is verified).
 *  5. The captain sets a username, positions and gender; the public player page shows the profile and
 *     never the gender.
 */
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/teams-${name}.png`, fullPage: true });

test("a captain invites a number by share link, the player signs up with it and joins, and the public page hides gender", async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const run = String(Date.now()).slice(-6);
  const team = `E2E Gladiators ${run}`;
  const captain = await (await browser.newContext()).newPage();
  const player = await (await browser.newContext()).newPage();
  const visitor = await (await browser.newContext()).newPage();

  // 1. The captain and the team.
  await signUpByPhone(captain, WEB, testPhone(), `E2E Captain ${run}`);
  await captain.goto(`${WEB}/me/teams`);
  await expect(captain.getByTestId("my-teams-empty")).toBeVisible();
  const create = captain.getByTestId("create-team");
  await create.getByLabel("Sport").selectOption("football");
  await create.getByLabel("Team name").fill(team);
  await create.getByLabel("Short code").fill("egl");
  await create.getByRole("button", { name: "Create team" }).click();
  await expect(captain.getByTestId("team-name")).toHaveText(team);
  const teamId = captain.url().split("/").pop()!;

  // 2. Invite a number with no account: a share link, and nothing sent to it.
  const phone = testPhone();
  const invite = captain.getByTestId("invite-form");
  await invite.getByLabel("Mobile number").fill(phone);
  await invite.getByRole("button", { name: "Invite", exact: true }).click();
  const shareUrl = await captain.getByTestId("share-url").inputValue();
  expect(shareUrl).toMatch(new RegExp(`^${WEB}/teams/join/[A-Za-z0-9_-]{20,}$`));
  await expect(captain.getByTestId("team-pending")).toContainText("•••");
  await expect(captain.getByRole("link", { name: "Share on WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=/);
  await shot(captain, "invite-link");
  expect(sql(`SELECT count(*) FROM team_invites WHERE team_id = '${teamId}' AND status = 'pending' AND user_id IS NULL`)).toBe("1");
  expect(sql(`SELECT count(*) FROM team_invites WHERE team_id = '${teamId}' AND phone_masked LIKE '%${phone.slice(-3)}'`)).toBe("1");

  // 3. The player signs up with that number, opens the link and joins.
  const { userId: playerId } = await signUpByPhone(player, WEB, phone, `E2E Player ${run}`);
  await player.goto(shareUrl);
  await expect(player.getByTestId("join-team")).toHaveText(team);
  await expect(player.getByTestId("join-invite")).toContainText("Invited by E2E");
  await shot(player, "join");
  await player.getByTestId("join-accept").click();
  await expect(player.getByTestId("team-name")).toHaveText(team);
  await expect(player.getByTestId("team-member")).toHaveCount(2);

  // 4. The captain sees both members, with the NID badge once the player's NID is verified.
  nidVerified(playerId);
  await captain.reload();
  const members = captain.getByTestId("team-member");
  await expect(members).toHaveCount(2);
  await expect(members.filter({ hasText: `E2E Player ${run}` }).getByTestId("member-nid")).toHaveText("NID ✓");
  await expect(members.filter({ hasText: `E2E Captain ${run}` }).getByTestId("member-nid")).toHaveText("NID not verified");
  await shot(captain, "members");

  // 5. Username, positions and gender; the public page shows the profile and not the gender.
  const handle = `e2ecap${run}`;
  await captain.goto(`${WEB}/me/player`);
  await captain.getByLabel("Username").fill(handle);
  await captain.getByRole("button", { name: "Set username" }).click();
  await expect(captain.getByTestId("public-page-link")).toHaveText(`/players/${handle}`);
  await captain.getByRole("checkbox", { name: "Football" }).check();
  await captain.getByRole("button", { name: "Goalkeeper" }).click();
  await captain.getByRole("button", { name: "Save", exact: true }).click();
  await expect(captain.getByText("Saved.")).toBeVisible();
  await captain.goto(`${WEB}/me/eligibility`);
  await expect(captain.getByTestId("ready-phone_verified")).toContainText("Done");
  await captain.getByRole("radio", { name: "Male", exact: true }).check();
  await captain.getByRole("button", { name: "Save gender" }).click();
  await expect(captain.getByTestId("gender-set")).toContainText("Male");
  await expect(captain.getByTestId("ready-gender_recorded")).toContainText("Done");
  await shot(captain, "eligibility");

  await visitor.goto(`${WEB}/players/${handle}`);
  await expect(visitor.getByTestId("player-name")).toHaveText(`E2E Captain ${run}`);
  await expect(visitor.getByTestId("player-sports")).toContainText("Goalkeeper");
  await expect(visitor.getByTestId("player-teams")).toContainText(team);
  const text = await visitor.getByTestId("public-player").innerText();
  expect(text).not.toMatch(/\bmale\b|gender|01\d{9}/i);
  await shot(visitor, "public-page");
});
