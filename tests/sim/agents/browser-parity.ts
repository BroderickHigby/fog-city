import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "@playwright/test";
import { createServer } from "vite";
import { replayPolicyTrace } from "./replay-fixture.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const port = Number(process.env.LANE3_EVAL_PORT ?? 5383);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid lane-3 evaluation port");
const server = await createServer({
  root, appType: "custom", logLevel: "error",
  server: { host: "127.0.0.1", port, strictPort: true },
});
let browser: Browser | undefined;
try {
  await server.listen();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`http://127.0.0.1:${port}/lane3-evaluation`, route => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Agent policy evaluation</title>",
  }));
  await page.goto(`http://127.0.0.1:${port}/lane3-evaluation`);
  const expected = replayPolicyTrace();
  const actual = await page.evaluate(async () => {
    const modulePath = "/tests/sim/agents/replay-fixture.ts";
    const fixture = await import(/* @vite-ignore */ modulePath) as { replayPolicyTrace(): string[] };
    return fixture.replayPolicyTrace();
  });
  assert.equal(expected.length, 30);
  assert.deepEqual(actual, expected, "Node and Chromium policy traces diverged");
  assert.deepEqual(errors, [], "Browser policy evaluation produced page errors");
  const report = {
    kind: "lane-3-policy-cross-runtime-parity", node: process.version,
    browser: await browser.version(), ticks: 1800, checkpoints: 30,
    match: true, hashes: actual,
    scope: "Brain, reaction, navigation and fidelity policies; no claim of integrated actor movement or clearance.",
  };
  const output = new URL("../../../test-results/lane3/", import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL("browser-parity.json", output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
