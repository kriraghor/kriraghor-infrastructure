import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against the local k3d cluster (local/k3d-up.sh + local/deploy.sh). Every app is reached
 * through ingress-nginx at *.kriraghor.localhost, exactly as a browser would.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", actionTimeout: 20_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
