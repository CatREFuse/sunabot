import { hostname } from "node:os";
import type http from "node:http";
import { readRemoteNapcat } from "../../packages/platform/remoteNapcat.mjs";
import type { NapcatConnectionInfo } from "../../packages/contracts/admin/public.js";
import { resolveOneBotListenerAddress, type OneBotListenerAddress } from "./onebotListener.js";

export async function describeNapcatConnection(
  workspace: string,
  overrides: Partial<OneBotListenerAddress>,
  reverseWsPath: string,
  boundAddress?: ReturnType<http.Server["address"]>
): Promise<NapcatConnectionInfo> {
  const defaults = resolveOneBotListenerAddress();
  const bound = boundAddress && typeof boundAddress !== "string" ? boundAddress : undefined;
  const listener = {
    host: bound?.address ?? overrides.host ?? defaults.host,
    port: bound?.port ?? overrides.port ?? defaults.port
  };
  const remote = await readRemoteNapcat(workspace);
  const address = (host: string) => `ws://${host.includes(":") ? `[${host}]` : host}:${listener.port}${reverseWsPath}`;
  return {
    mode: remote ? "remote" : "local",
    host: remote?.host ?? hostname(),
    transport: remote ? "ssh" : "direct",
    onebotUrl: address(remote?.gateway ?? listener.host),
    onebotPort: listener.port,
    coreUrl: address(listener.host)
  };
}
