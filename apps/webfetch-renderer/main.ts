import { createHash } from "node:crypto";
import Fastify from "fastify";
import { chromium, type Browser, type Page } from "playwright";
import { resolvePublicWebTarget } from "../../adapters/webfetch/urlPolicy.js";
import { RendererLimiter, RendererQueueFullError } from "./rendererLimiter.js";
import { startSafeWebProxy } from "./safeProxy.js";

const HOST = process.env.SUNABOT_WEBFETCH_RENDERER_HOST?.trim() || "0.0.0.0";
const PORT = readPort(process.env.SUNABOT_WEBFETCH_RENDERER_PORT, 8790);
const MAX_DOM_BYTES = 4 * 1024 * 1024;
const NAVIGATION_TIMEOUT_MS = 12_000;
const MAX_CONCURRENCY = 2;
const MAX_QUEUED_RENDERS = 16;
const CHROMIUM_SANDBOX = readChromiumSandbox(process.env.SUNABOT_WEBFETCH_CHROMIUM_SANDBOX);
const blockedResourceTypes = new Set(["image", "media", "font"]);

const app = Fastify({ logger: false, bodyLimit: 8 * 1024 });
const limiter = new RendererLimiter(MAX_CONCURRENCY, MAX_QUEUED_RENDERS);
const proxy = await startSafeWebProxy();
const browser = await launchBrowser(proxy.url);
let shuttingDown = false;

app.get("/healthz", async (_request, reply) => {
  reply.code(browser.isConnected() ? 200 : 503).send({
    ok: browser.isConnected(),
    browserIsolation: CHROMIUM_SANDBOX ? "chromium-sandbox" : "container-sandbox"
  });
});

app.post<{ Body: { url?: unknown } }>("/render", async (request, reply) => {
  if (!request.body
    || typeof request.body.url !== "string"
    || request.body.url.trim().length < 1
    || request.body.url.trim().length > 4_096
    || Object.keys(request.body).length !== 1) {
    reply.code(400).send({ ok: false, code: "INVALID_INPUT" });
    return;
  }
  let url: string;
  try {
    url = (await resolvePublicWebTarget(request.body.url.trim())).url.href;
  } catch {
    reply.code(400).send({ ok: false, code: "URL_NOT_ALLOWED" });
    return;
  }
  if (new URL(url).protocol === "https:") {
    reply.code(422).send({ ok: false, code: "DYNAMIC_HTTPS_DISABLED" });
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Renderer client disconnected."));
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  try {
    const result = await limiter.run(() => render(browser, proxy, url, controller.signal), controller.signal);
    reply.code(200).send(result);
  } catch (error) {
    if (error instanceof RendererQueueFullError) {
      reply.code(429).send({ ok: false, code: "RENDER_QUEUE_FULL" });
    } else if (!controller.signal.aborted) {
      reply.code(502).send({ ok: false, code: "DYNAMIC_RENDER_FAILED" });
    }
  } finally {
    request.raw.off("aborted", abort);
    reply.raw.off("close", abort);
  }
});

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  limiter.close();
  await app.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await proxy.close().catch(() => undefined);
};
browser.once("disconnected", () => {
  if (shuttingDown) return;
  void shutdown().finally(() => process.exit(1));
});
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));

await app.listen({ host: HOST, port: PORT });

async function launchBrowser(proxyUrl: string) {
  return chromium.launch({
    headless: true,
    chromiumSandbox: CHROMIUM_SANDBOX,
    proxy: { server: proxyUrl },
    args: [
      "--disable-background-networking",
      "--disable-breakpad",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-features=WebRtcHideLocalIpsWithMdns,MediaRouter,OptimizationHints,AutofillServerCommunication",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--proxy-bypass-list=<-loopback>",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp"
    ]
  });
}

async function render(
  browserInstance: Browser,
  safeProxy: Awaited<ReturnType<typeof startSafeWebProxy>>,
  url: string,
  signal: AbortSignal
) {
  const budget = safeProxy.openBudget();
  const context = await browserInstance.newContext({
    acceptDownloads: false,
    serviceWorkers: "block",
    javaScriptEnabled: true,
    permissions: [],
    locale: "zh-CN",
    userAgent: "Sunabot-WebFetch-Renderer/1.0"
  });
  const page = await context.newPage();
  const abort = () => void context.close().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  page.on("popup", (popup) => void popup.close());
  // Install the policy at context scope so popup pages cannot create an
  // unfiltered network path before the popup close handler runs.
  await context.routeWebSocket("**/*", (webSocket) => webSocket.close());
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() !== "GET" || blockedResourceTypes.has(request.resourceType())) {
      await route.abort("blockedbyclient");
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(request.url());
      if (parsed.protocol !== "http:") throw new Error("protocol");
      await resolvePublicWebTarget(parsed, undefined, signal);
    } catch {
      await route.abort("blockedbyclient");
      return;
    }
    const headers = { ...request.headers() };
    for (const key of ["authorization", "cookie", "proxy-authorization", "origin", "referer"]) delete headers[key];
    headers["x-sunabot-render-budget"] = budget.id;
    await route.continue({ headers });
  });
  try {
    if (signal.aborted) throw signal.reason ?? new Error("Renderer request aborted.");
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    const navigation = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    // The renderer is only an HTML acquisition path.  Do not hand a browser
    // error page, PDF viewer or another non-HTML document to the extractor.
    const contentType = navigation?.headers()["content-type"] ?? "";
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType.trim())) {
      throw new Error("rendered document is not HTML");
    }
    await page.waitForLoadState("networkidle", {
      timeout: Math.min(4_000, Math.max(1, deadline - Date.now()))
    }).catch(() => undefined);
    await waitForStableBody(page, deadline);
    if (signal.aborted) throw signal.reason ?? new Error("Renderer request aborted.");
    const finalUrl = (await resolvePublicWebTarget(page.url(), undefined, signal)).url.href;
    const html = await page.content();
    if (Buffer.byteLength(html, "utf8") > MAX_DOM_BYTES) throw new Error("rendered DOM too large");
    return { html, finalUrl };
  } finally {
    signal.removeEventListener("abort", abort);
    await context.close();
    budget.close();
  }
}

async function waitForStableBody(page: Page, deadline: number) {
  let previous = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const body = await page.locator("body").innerText({ timeout: Math.min(1_000, remaining) }).catch(() => "");
    const fingerprint = createHash("sha256").update(body.slice(0, 200_000)).digest("hex");
    if (fingerprint === previous) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 750) return;
    } else {
      previous = fingerprint;
      stableSince = 0;
    }
    const pause = Math.min(250, Math.max(0, deadline - Date.now()));
    if (pause <= 0) break;
    await page.waitForTimeout(pause);
  }
}

function readPort(value: string | undefined, fallback: number) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid renderer port");
  return port;
}

function readChromiumSandbox(value: string | undefined) {
  if (value == null || value.trim() === "" || value === "1") return true;
  if (value === "0") return false;
  throw new Error("SUNABOT_WEBFETCH_CHROMIUM_SANDBOX must be 0 or 1");
}
