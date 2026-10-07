// Secretless transport proof: the fixture is not the Feishu service.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { expect, it } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { createFeishuClient } from "./client.js";
import { withFeishuSendContext } from "./send-context.js";
import { sendMessageFeishu } from "./send.js";

it("proves current production retry owners over real SDK HTTP transport", async () => {
  const require = createRequire(import.meta.url);
  const sdkVersion = (require("@larksuiteoapi/node-sdk/package.json") as { version: string }).version;
  expect(sdkVersion).toBe("1.74.0");
  const sourceSha = process.env.OPENCLAW_PROOF_SOURCE_SHA;
  expect(sourceSha).toBe("70b58575edd3edc60dde7ff25141f36be29bb77f");
  const startedAt = performance.now();
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  let suppressedDiagnostics = 0;
  const suppressDiagnostic = () => { suppressedDiagnostics += 1; };
  const emit = (event: Record<string, unknown>) => {
    originalConsole.log(`PROOF ${JSON.stringify({ sourceSha, sdkVersion, fixture: "loopback-not-live-feishu", ...event })}`);
  };
  type Scenario = "direct-reset" | "thread-reset" | "direct-503" | "cancel-reset";
  let scenario: Scenario = "direct-reset";
  let handoffs = 0;
  let tokenPosts = 0;
  let unexpectedOutbound = 0;
  let fixtureFailure: unknown;
  const controller = new AbortController();
  const records: Array<{ scenario: Scenario; uuid: string; path: string; handoff: number }> = [];
  const accepted = new Map<string, string>();
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      expect(request.method).toBe("POST");
      const json = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
        expect(body.app_id).toBe("cli_transport_proof");
        expect(body.app_secret).toBe("synthetic-placeholder");
        tokenPosts += 1;
        expect(handoffs).toBe(0);
        emit({ event: "sdk-token-exchange", path: url.pathname, attempt: tokenPosts, handoff: 0 });
        json(200, { code: 0, tenant_access_token: "synthetic-token", expire: 7200 });
        return;
      }
      const expectedPath = scenario === "thread-reset"
        ? "/open-apis/im/v1/messages/om_fixture_parent/reply"
        : "/open-apis/im/v1/messages";
      expect(url.pathname).toBe(expectedPath);
      expect(request.headers.authorization === "Bearer synthetic-token").toBe(true);
      expect(body.msg_type).toBe("post");
      expect(typeof body.content).toBe("string");
      if (scenario === "thread-reset") {
        expect(body.reply_in_thread).toBe(true);
      } else {
        expect(body.receive_id).toBe("oc_fixture_transport");
        expect(url.searchParams.get("receive_id_type")).toBe("chat_id");
      }
      const uuid = body.uuid;
      expect(typeof uuid).toBe("string");
      if (typeof uuid !== "string") {
        throw new Error("missing production UUID");
      }
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const attempt = records.filter((entry) => entry.scenario === scenario).length + 1;
      expect(handoffs).toBe(records.length + 1);
      records.push({ scenario, uuid, path: url.pathname, handoff: handoffs });
      emit({ event: "wire-message", scenario, uuid, path: url.pathname, attempt, handoff: handoffs });
      if (scenario === "direct-503" && attempt === 1) {
        emit({ event: "http-503-before-fixture-acceptance", scenario, uuid, attempt });
        json(503, { code: 1663, msg: "synthetic transient failure" });
        return;
      }
      if (!accepted.has(uuid)) {
        accepted.set(uuid, `om_fixture_${scenario}`);
        emit({ event: "fixture-accepted", scenario, uuid, messageId: accepted.get(uuid) });
      }
      if (attempt === 1 && scenario !== "direct-503") {
        if (scenario === "cancel-reset") {
          controller.abort(new Error("synthetic sender retirement"));
          emit({ event: "sender-retired-before-retry", scenario, uuid, attempt });
        }
        emit({ event: "socket-destroyed-after-fixture-acceptance", scenario, uuid, attempt });
        request.socket.destroy();
        return;
      }
      json(200, { code: 0, msg: "success", data: { message_id: accepted.get(uuid) } });
    })().catch((error: unknown) => {
      fixtureFailure = error;
      request.socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cfg = {
    channels: { feishu: {
      enabled: true,
      appId: "cli_transport_proof",
      appSecret: "synthetic-placeholder", // pragma: allowlist secret
      domain: "feishu",
    } },
  } as ClawdbotConfig;
  // Harness logging control only: never print SDK/Axios diagnostics or request payloads.
  Object.assign(console, { log: suppressDiagnostic, info: suppressDiagnostic, warn: suppressDiagnostic, error: suppressDiagnostic, debug: suppressDiagnostic });
  let client: ReturnType<typeof createFeishuClient> | undefined;
  let originalSdkError: ReturnType<typeof createFeishuClient>["logger"]["error"] | undefined;
  let interceptor: number | undefined;
  try {
  client = createFeishuClient({ appId: "cli_transport_proof", appSecret: "synthetic-placeholder", domain: "feishu" }); // pragma: allowlist secret
  // Public SDK logger seam: prevent Axios diagnostics printing synthetic auth payloads.
  originalSdkError = client.logger.error;
  client.logger.error = () => {};
  interceptor = Lark.defaultHttpInstance.interceptors.request.use((options) => {
    const url = new URL(options.url ?? "");
    const allowedPath = url.pathname === "/open-apis/auth/v3/tenant_access_token/internal"
      || url.pathname === "/open-apis/im/v1/messages"
      || url.pathname === "/open-apis/im/v1/messages/om_fixture_parent/reply";
    if (url.origin !== "https://open.feishu.cn" || !allowedPath || options.method?.toUpperCase() !== "POST") {
      unexpectedOutbound += 1;
      throw new Error("proof rejected unexpected outbound request");
    }
    options.url = new URL(`${url.pathname}${url.search}`, origin).toString();
    options.maxRedirects = 0;
    options.proxy = false;
    return options;
  }, undefined, { synchronous: true });
  const invoke = (signal?: AbortSignal) => withFeishuSendContext({
    signal,
    onPlatformSendDispatch: async () => {
      handoffs += 1;
      emit({ event: "production-handoff", scenario, handoff: handoffs });
    },
  }, () => sendMessageFeishu({
    cfg,
    to: "chat:oc_fixture_transport",
    text: "Synthetic production transport recovery proof",
    ...(scenario === "thread-reset" ? { replyToMessageId: "om_fixture_parent", replyInThread: true } : {}),
  }));
    for (const next of ["direct-reset", "thread-reset", "direct-503"] as const) {
      scenario = next;
      const result = await invoke();
      const requests = records.filter((entry) => entry.scenario === scenario);
      expect(requests).toHaveLength(2);
      expect(requests[1].uuid).toBe(requests[0].uuid);
      expect(result.messageId).toBe(`om_fixture_${scenario}`);
      expect(result.receipt.primaryPlatformMessageId).toBe(result.messageId);
      expect(result.receipt.parts).toHaveLength(1);
      if (scenario === "thread-reset") {
        expect(result.receipt.replyToId).toBe("om_fixture_parent");
      }
      emit({ event: "production-result", scenario, uuid: requests[0].uuid, messageId: result.messageId, receiptParts: result.receipt.parts.length, attempts: requests.length, fixtureAcceptances: 1 });
    }
    scenario = "cancel-reset";
    await expect(invoke(controller.signal)).rejects.toThrow(/retired before request dispatch/);
    expect(records.filter((entry) => entry.scenario === scenario)).toHaveLength(1);
    expect(handoffs).toBe(7);
    expect(records).toHaveLength(7);
    expect(tokenPosts).toBe(1);
    expect(new Set(records.map((entry) => entry.uuid)).size).toBe(4);
    expect(accepted.size).toBe(4);
    expect(unexpectedOutbound).toBe(0);
    expect(fixtureFailure).toBeUndefined();
    emit({ event: "completed", scenarios: 4, messagePosts: records.length, handoffs, tokenPosts, distinctLogicalUuids: accepted.size, cancelledSecondPost: false, unexpectedOutbound, suppressedDiagnostics, wallTimeMs: Math.round(performance.now() - startedAt) });
  } finally {
    if (interceptor !== undefined) {
      Lark.defaultHttpInstance.interceptors.request.eject(interceptor);
    }
    if (client && originalSdkError) {
      client.logger.error = originalSdkError;
    }
    server.closeAllConnections();
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      Object.assign(console, originalConsole);
    }
  }
}, 10_000);
