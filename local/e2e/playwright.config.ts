import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against the local k3d cluster (local/k3d-up.sh + local/deploy.sh). Every app is reached
 * through ingress-nginx at *.kriraghor.localhost, exactly as a browser would.
 *
 * Chromium resolves *.localhost itself and may connect to [::1]:80. On Windows with WSL, wslrelay
 * owns [::1]:80 and some of those connections hang until they reset, so the hosts are pinned to the
 * IPv4 loopback the k3d load balancer listens on.
 */
const HOSTS = "MAP kriraghor.localhost 127.0.0.1,MAP *.kriraghor.localhost 127.0.0.1";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", actionTimeout: 20_000, launchOptions: { args: [`--host-resolver-rules=${HOSTS}`] } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
