import type { FastifyInstance } from "fastify";
import type { ConfigDoctorService } from "../../../src/admin/configDoctor.js";
import { badRequest } from "../../../src/admin/errors.js";

type ConfigDoctorRoutesService = Pick<ConfigDoctorService, "scan" | "propose" | "apply">;

const issueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "path", "message", "severity", "repairable", "source"],
  properties: {
    id: { type: "string" },
    path: { type: "string" },
    message: { type: "string" },
    severity: { type: "string", enum: ["warning", "error"] },
    repairable: { type: "boolean" },
    source: { type: "string", enum: ["rules", "syntax", "ai"] }
  }
} as const;
const changeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "action", "summary", "risk"],
  properties: {
    path: { type: "string" },
    action: { type: "string", enum: ["add", "replace", "remove"] },
    summary: { type: "string" },
    risk: { type: "string", enum: ["low", "medium"] }
  }
} as const;
const providerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "model", "destination"],
  properties: {
    label: { type: "string" },
    model: { type: "string" },
    destination: { type: "string" }
  }
} as const;
const proposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sourceRevision", "expiresAt", "risk", "source", "changes"],
  properties: {
    id: { type: "string" },
    sourceRevision: { type: "string" },
    expiresAt: { type: "string" },
    risk: { type: "string", enum: ["low", "medium"] },
    source: { type: "string", enum: ["rules", "ai"] },
    changes: { type: "array", items: changeSchema }
  }
} as const;
const reportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "generatedAt", "sourceRevision", "status", "issues", "ai"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    generatedAt: { type: "string" },
    sourceRevision: { type: "string" },
    status: { type: "string", enum: ["healthy", "repairable", "manual"] },
    issues: { type: "array", items: issueSchema },
    proposal: proposalSchema,
    ai: {
      type: "object",
      additionalProperties: false,
      required: ["available"],
      properties: {
        available: { type: "boolean" },
        provider: providerSchema,
        summary: { type: "string" }
      }
    }
  }
} as const;
const applyResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "ok", "repairId", "repairedAt", "sourceRevision", "backupPath",
    "restartRequired", "appliedChanges"
  ],
  properties: {
    ok: { type: "boolean", enum: [true] },
    repairId: { type: "string" },
    repairedAt: { type: "string" },
    sourceRevision: { type: "string" },
    backupPath: { type: "string" },
    restartRequired: { type: "boolean" },
    appliedChanges: { type: "integer", minimum: 0 }
  }
} as const;
const sourceRevisionBody = {
  type: "object",
  additionalProperties: false,
  required: ["sourceRevision"],
  properties: { sourceRevision: { type: "string", minLength: 1, maxLength: 128 } }
} as const;
const applyBody = {
  type: "object",
  additionalProperties: false,
  required: ["proposalId", "sourceRevision"],
  properties: {
    proposalId: { type: "string", minLength: 1, maxLength: 128 },
    sourceRevision: { type: "string", minLength: 1, maxLength: 128 }
  }
} as const;

export function registerConfigDoctorRoutes(app: FastifyInstance, service: ConfigDoctorRoutesService) {
  app.get("/api/config-doctor/scan", {
    schema: { querystring: { type: "object", additionalProperties: false }, response: { 200: reportSchema } }
  }, async () => service.scan());

  app.post("/api/config-doctor/propose", {
    schema: { body: sourceRevisionBody, response: { 200: reportSchema } }
  }, async (request) => {
    const sourceRevision = stringField(request.body, "sourceRevision");
    return service.propose(sourceRevision);
  });

  app.post("/api/config-doctor/apply", {
    schema: { body: applyBody, response: { 200: applyResultSchema } }
  }, async (request) => service.apply({
    proposalId: stringField(request.body, "proposalId"),
    sourceRevision: stringField(request.body, "sourceRevision")
  }));
}

function stringField(body: unknown, field: string) {
  const value = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)[field]
    : undefined;
  if (typeof value !== "string" || !value.trim()) {
    badRequest("CONFIG_DOCTOR_REQUEST_INVALID", `缺少 ${field}。`, field);
  }
  return value.trim();
}
