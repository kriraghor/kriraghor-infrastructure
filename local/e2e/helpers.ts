import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { authenticator } from "otplib";

/** Shared helpers for the k3d end-to-end checks (local dev cluster only; codes come from dev drivers). */
export const D = "kriraghor.localhost";
export const WEB = `http://${D}`;
export const ESPORTS = `http://esports.${D}`;
export const ADMIN = `http://admin.${D}`;
export const VENDOR = `http://vendor.${D}`;
export const MAIL = `http://mail.${D}`;
export const API = `http://api.${D}/api/v1`;
export const CONTEXT = process.env.KUBE_CONTEXT ?? "k3d-kriraghor";
export const MASTER_PHONE = process.env.MASTER_PHONE ?? "01711000001";
export const STATE_FILE = path.join(__dirname, ".state.json"); // the master's TOTP secret between runs (gitignored)

/** Latest 6-digit code emailed to `to`, read from the Mailpit API through the browser (it resolves *.localhost). */
export async function emailCode(page: Page, to: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    await page.goto(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const list = JSON.parse((await page.textContent("body")) ?? "{}") as { messages?: { ID: string }[] };
    if (list.messages?.length) {
      await page.goto(`${MAIL}/api/v1/message/${list.messages[0].ID}`);
      const msg = JSON.parse((await page.textContent("body")) ?? "{}") as { Text?: string };
      const code = msg.Text?.match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`no email code for ${to}`);
}

/** Latest SMS code for a number from the API pod's console SMS driver (dev only). */
export function smsCode(local: string): string {
  const e164 = `+880${local.slice(1)}`;
  for (let i = 0; i < 20; i++) {
    const logs = execSync(`kubectl --context ${CONTEXT} -n kriraghor logs deploy/backend-api --since=5m`, { encoding: "utf8" });
    const blocks = logs.split("[sms:console]").filter((b) => b.includes(`to=${e164}`));
    const code = blocks.at(-1)?.match(/\b(\d{6})\b/)?.[1];
    if (code) return code;
    execSync(process.platform === "win32" ? "ping -n 2 127.0.0.1 >NUL" : "sleep 1");
  }
  throw new Error(`no SMS code for ${local}`);
}

/** A TOTP code for the master from the saved secret, in a 30 s step not used before (the API refuses replays). */
let lastStep = 0;
export async function masterTotp(page: Page): Promise<string> {
  const secret = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).secret as string;
  const step = () => Math.floor(Date.now() / 30000);
  while (step() <= lastStep) await page.waitForTimeout(1000);
  lastStep = step();
  return authenticator.generate(secret);
}

/** Sign up on a customer site with an email code. Returns the new user's id. */
export async function signUpByEmail(page: Page, helper: Page, site: string, name: string): Promise<{ email: string; userId: string }> {
  const email = `e2e+${Date.now()}${Math.floor(Math.random() * 1000)}@kriraghor.test`;
  await page.goto(`${site}/sign-in`);
  await page.getByRole("tab", { name: "Email code" }).click();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  await page.getByLabel("6-digit code").fill(await emailCode(helper, email));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page).toHaveURL(`${site}/me`);
  const userId = ((await page.getByTestId("me-id").textContent()) ?? "").trim();
  return { email, userId };
}

/** A fresh Grameenphone-style number for a test account (017 + 8 digits). */
export const testPhone = () => `017${String(Date.now()).slice(-8)}`;

/** Sign up on a customer site with a phone code (from the console SMS driver). Returns the new user's id. */
export async function signUpByPhone(page: Page, site: string, phone: string, name: string): Promise<{ userId: string }> {
  await page.goto(`${site}/sign-in`);
  await page.getByRole("tab", { name: "Phone code" }).click();
  await page.getByLabel("Mobile number").fill(phone);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  await page.getByLabel("6-digit code").fill(smsCode(phone));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Create my account" }).click();
  await expect(page).toHaveURL(`${site}/me`);
  return { userId: ((await page.getByTestId("me-id").textContent()) ?? "").trim() };
}

/**
 * The master's admin access token through the API (login code by SMS, then TOTP), for driving desk
 * endpoints from a test. Waits out the one-code-per-minute cooldown if a previous test just signed in.
 */
export async function masterToken(request: APIRequestContext, page: Page): Promise<string> {
  const headers = { Origin: ADMIN };
  for (let attempt = 0; attempt < 3; attempt++) {
    const sent = await request.post(`${API}/auth/otp/send`, { data: { target: MASTER_PHONE, purpose: "login" } });
    if (sent.status() !== 429) break;
    const wait = Number((await sent.json()).retryAfter ?? 60);
    await page.waitForTimeout((wait + 1) * 1000);
  }
  const login = await request.post(`${API}/auth/admin/login`, { headers, data: { target: MASTER_PHONE, code: smsCode(MASTER_PHONE) } });
  expect(login.ok()).toBeTruthy();
  const { challengeToken } = await login.json();
  const verified = await request.post(`${API}/auth/2fa/totp/verify`, { headers, data: { challengeToken, code: await masterTotp(page) } });
  expect(verified.ok()).toBeTruthy();
  return (await verified.json()).accessToken as string;
}

/** A single-use step-up token for the master. */
export async function masterStepUp(request: APIRequestContext, page: Page, token: string, scope: string): Promise<string> {
  const res = await request.post(`${API}/auth/step-up`, { headers: { Authorization: `Bearer ${token}` }, data: { scope, code: await masterTotp(page) } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).stepUpToken as string;
}
