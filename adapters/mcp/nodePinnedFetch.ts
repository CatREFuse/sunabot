import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { mcpDnsHostname, type McpDnsResolver, type McpPinnedFetch } from "./controlledHttp.js";

export const resolveMcpHostname: McpDnsResolver = async (hostname) => {
  const addresses = await dns.lookup(mcpDnsHostname(hostname), { all: true, verbatim: true });
  return [...new Set(addresses.map((entry) => entry.address))];
};

export const fetchPinnedMcpAddress: McpPinnedFetch = async (url, init, validatedAddresses) => {
  const selected = validatedAddresses[0];
  const family = selected ? net.isIP(selected) : 0;
  if (!selected || (family !== 4 && family !== 6)) throw stableError("MCP_HTTP_ENDPOINT_UNSAFE");
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, _options, callback) {
        if (mcpDnsHostname(hostname).toLowerCase() !== mcpDnsHostname(url.hostname).toLowerCase()) {
          callback(stableError("MCP_HTTP_DNS_PIN_MISMATCH"), "", 0);
          return;
        }
        callback(null, selected, family);
      }
    }
  });
  const cleanup = createStrictDispatcherCleanup(dispatcher);
  try {
    const response = await undiciFetch(url, ({
      ...init,
      dispatcher
    }) as unknown as Parameters<typeof undiciFetch>[1]);
    return await responseWithDispatcherCleanup(response as unknown as Response, cleanup);
  } catch (error) {
    await cleanup();
    throw error;
  }
};

export interface McpPinnedDispatcher {
  close(): Promise<void>;
  destroy(error?: Error): Promise<void>;
}

export async function responseWithDispatcherCleanup(
  response: Response,
  dispatcherOrCleanup: McpPinnedDispatcher | (() => Promise<void>),
  timeoutMs = 5_000
) {
  const cleanup = typeof dispatcherOrCleanup === "function"
    ? dispatcherOrCleanup
    : createStrictDispatcherCleanup(dispatcherOrCleanup, timeoutMs);
  if (!response.body) {
    await cleanup();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await cleanup();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        try {
          await cleanup();
          controller.error(error);
        } catch (cleanupError) {
          controller.error(cleanupError);
        }
      }
    },
    async cancel(reason) {
      let cancelFailed = false;
      try {
        await reader.cancel(reason);
      } catch {
        cancelFailed = true;
      }
      await cleanup();
      if (cancelFailed) throw stableError("MCP_HTTP_CLEANUP_FAILED");
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export function createStrictDispatcherCleanup(dispatcher: McpPinnedDispatcher, timeoutMs = 5_000) {
  let cleanup: Promise<void> | undefined;
  return () => {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      try {
        await withCleanupDeadline(dispatcher.close(), timeoutMs);
      } catch {
        try {
          await withCleanupDeadline(dispatcher.destroy(stableError("MCP_HTTP_CLEANUP_FAILED")), timeoutMs);
        } catch {
          // The stable cleanup error below remains the only exposed detail.
        }
        throw stableError("MCP_HTTP_CLEANUP_FAILED");
      }
    })();
    return cleanup;
  };
}

async function withCleanupDeadline(operation: Promise<void>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(stableError("MCP_HTTP_CLEANUP_FAILED")), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}
