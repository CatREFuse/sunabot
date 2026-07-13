import type { FastifyInstance } from "fastify";
import { type AdminAuthService, isAdminProtectedPath } from "../../../src/admin/auth.js";

type AuthRouteService = Pick<
  AdminAuthService,
  "authorize" | "getSessionStatus" | "login" | "logout" | "changePassword" | "getFuseStatus" | "tripFuse"
>;

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;

export function registerAuthRoutes(app: FastifyInstance, adminAuth: AuthRouteService) {
  app.addHook("onRequest", async (request) => {
    if (isAdminProtectedPath(request.raw.url ?? request.url)) await adminAuth.authorize(request);
  });

  app.get("/api/auth/session", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => adminAuth.getSessionStatus(request));

  app.post("/api/auth/login", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request, reply) => adminAuth.login(request, reply, request.body));

  app.post("/api/auth/logout", {
    schema: { querystring: openObject, response: { 204: { type: "null" } } }
  }, async (request, reply) => {
    adminAuth.logout(request, reply);
    return reply.status(204).send();
  });

  app.post("/api/auth/password", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request, reply) => adminAuth.changePassword(request, reply, request.body));

  app.get("/api/auth/security", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => ({ fuse: adminAuth.getFuseStatus() }));

  app.post("/api/auth/fuse", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => {
    await adminAuth.tripFuse("webui-emergency");
    return { ok: true, fuse: adminAuth.getFuseStatus() };
  });
}
