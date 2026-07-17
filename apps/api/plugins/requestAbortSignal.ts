import type { FastifyReply, FastifyRequest } from "fastify";

export async function withFastifyRequestSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  errorCode: string,
  run: (signal: AbortSignal) => Promise<T>
) {
  const controller = new AbortController();
  const abort = () => {
    if (!reply.raw.writableFinished && !reply.raw.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error(errorCode));
    }
  };
  request.raw.once("aborted", abort);
  request.raw.socket?.once("close", abort);
  reply.raw.once("close", abort);
  try {
    return await run(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
    request.raw.socket?.off("close", abort);
    reply.raw.off("close", abort);
  }
}
