import { execSync } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { authenticator } from "otplib";

/**
 * kubectl against the local k3d API server, retried when the server is briefly unreachable (a TLS
 * handshake timeout while image builds load the machine). Other failures throw at once.
 */
function kubectl(args: string, input?: string): string {
  for (let attempt = 1; ; attempt++) {
    try {
      return execSync(`kubectl --context ${CONTEXT} ${args}`, { encoding: "utf8", ...(input === undefined ? {} : { input }) });
    } catch (err) {
      const text = String((err as { stderr?: unknown }).stderr ?? (err as Error).message);
      if (attempt >= 6 || !/TLS handshake timeout|Unable to connect to the server|connection refused|i\/o timeout/i.test(text)) throw err;
      execSync(process.platform === "win32" ? "ping -n 6 127.0.0.1 >NUL" : "sleep 5");
    }
  }
}

// *.localhost always means this machine (RFC 6761). Browsers know that; some Windows resolvers do not,
// so API calls from the test process (APIRequestContext) resolve these names locally. Test process only.
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
const systemLookup = dns.lookup;
(dns as unknown as { lookup: unknown }).lookup = (hostname: string, options: unknown, callback?: LookupCallback) => {
  const cb = (typeof options === "function" ? options : callback) as LookupCallback;
  const opts = (typeof options === "object" && options) || {};
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    if ((opts as dns.LookupOptions).all) return process.nextTick(() => cb(null, [{ address: "127.0.0.1", family: 4 }]));
    return process.nextTick(() => cb(null, "127.0.0.1", 4));
  }
  return (systemLookup as (...args: unknown[]) => void)(hostname, options, callback);
};
// Playwright's API client resolves through dns.promises.lookup.
const systemPromisesLookup = dns.promises.lookup;
(dns.promises as unknown as { lookup: unknown }).lookup = async (hostname: string, options?: dns.LookupOptions) => {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    if (options?.family === 6) return options.all ? [] : { address: "::1", family: 6 };
    return options?.all ? [{ address: "127.0.0.1", family: 4 }] : { address: "127.0.0.1", family: 4 };
  }
  return systemPromisesLookup(hostname, options as dns.LookupOptions);
};

/** Shared helpers for the k3d end-to-end checks (local dev cluster only; codes come from dev drivers). */
export const D = "kriraghor.localhost";
export const WEB = `http://${D}`;
export const ESPORTS = `http://esports.${D}`;
export const GYM = `http://gym.${D}`;
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
    const logs = kubectl("-n kriraghor logs deploy/backend-api --since=5m");
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

/**
 * The /signup wizard's first step: the mobile or email, then the code. Six digits submit by
 * themselves (filling the first box spreads the code over all six).
 */
export async function startSignUp(page: Page, site: string, target: string, code: () => Promise<string> | string) {
  await page.goto(`${site}/signup`);
  await page.getByLabel("Mobile number or email").fill(target);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  await page.getByLabel("6-digit code").fill(await code());
}

/** The rest of the wizard: name, the goal step where the site has one (kriraghor.com), then the account page. */
export async function finishSignUp(page: Page, site: string, name: string) {
  await page.getByLabel("Your name").fill(name);
  await page.getByTestId("signup-about-next").click();
  const create = page.getByTestId("signup-create");
  const done = page.getByTestId("signup-done");
  await expect(create.or(done)).toBeVisible();
  if (await create.isVisible()) await create.click();
  await expect(done).toBeVisible();
  await page.getByRole("link", { name: "Go to my account" }).click();
  await expect(page).toHaveURL(`${site}/me`);
}

/** Sign up on a customer site with an email code. Returns the new user's id. */
export async function signUpByEmail(page: Page, helper: Page, site: string, name: string): Promise<{ email: string; userId: string }> {
  const email = `e2e+${Date.now()}${Math.floor(Math.random() * 1000)}@kriraghor.test`;
  await startSignUp(page, site, email, () => emailCode(helper, email));
  await finishSignUp(page, site, name);
  const userId = ((await page.getByTestId("me-id").textContent()) ?? "").trim();
  return { email, userId };
}

/** A fresh Grameenphone-style number for a test account (017 + 8 digits). */
export const testPhone = () => `017${String(Date.now()).slice(-8)}`;

/** Sign up on a customer site with a phone code (from the console SMS driver). Returns the new user's id. */
export async function signUpByPhone(page: Page, site: string, phone: string, name: string): Promise<{ userId: string }> {
  await startSignUp(page, site, phone, () => smsCode(phone));
  await finishSignUp(page, site, name);
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

/**
 * Run SQL in the in-cluster dev database (k3d only): move stored times for jobs and windows, build
 * fixtures, read ledger balances. The statement goes in on stdin, so quotes need no shell escaping.
 */
export function sql(statement: string): string {
  return kubectl("-n kriraghor-data exec -i postgres-0 -- psql -U kriraghor -d kriraghor -v ON_ERROR_STOP=1 -tA", statement).trim();
}
