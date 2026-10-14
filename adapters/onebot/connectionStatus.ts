import type { MessagingStatusV1 } from "../../packages/contracts/messaging/messages.js";

type AccountConnection = NonNullable<MessagingStatusV1["accounts"]>[number];

export function summarizeOneBotConnections(connections: readonly AccountConnection[]) {
  const accounts = connections.map((connection) => ({ ...connection }));
  return {
    connected: accounts.length > 0,
    connections: accounts.length,
    selfIds: accounts.flatMap((account) => account.selfId ? [account.selfId] : []),
    accounts,
    connectedAt: accounts[0]?.connectedAt,
    lastEventAt: accounts.flatMap((account) => account.lastEventAt ? [account.lastEventAt] : []).sort().at(-1),
    lastMessageEventAt: accounts.flatMap((account) => account.lastMessageEventAt ? [account.lastMessageEventAt] : []).sort().at(-1)
  };
}
