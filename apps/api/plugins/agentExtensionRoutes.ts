import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import {
  AgentExtensionServiceError,
  MAX_SKILL_ARCHIVE_BYTES,
  type AgentExtensionService
} from "../../../services/extensions/public.js";

type AgentExtensionRouteService = Pick<
  AgentExtensionService,
  | "overview"
  | "installSkill"
  | "reviewSkill"
  | "previewCopy"
  | "applyCopy"
  | "setSkillEnabled"
  | "uninstallSkill"
  | "previewMcpServer"
  | "putMcpServer"
  | "setMcpServerEnabled"
  | "removeMcpServer"
>;

export interface AgentExtensionRouteOptions {
  service: AgentExtensionRouteService;
  adminGuard: preHandlerHookHandler;
  onAgentExtensionsChanged?: (agentId: string) => Promise<void>;
}

const agentId = { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$", maxLength: 32 } as const;
const extensionId = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 } as const;
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const secretStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["configuredKeys", "missingKeys"],
  properties: {
    configuredKeys: { type: "array", maxItems: 64, items: { type: "string" } },
    missingKeys: { type: "array", maxItems: 64, items: { type: "string" } }
  }
} as const;
const sourceSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "upload" } }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "agentId", "skillId"],
      properties: { kind: { const: "copy" }, agentId, skillId: extensionId }
    }
  ]
} as const;
const mcpDependencySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "description", "transport", "url"],
  properties: {
    id: extensionId,
    description: { type: "string", maxLength: 500 },
    transport: { const: "streamable_http" },
    url: { type: "string", minLength: 1, maxLength: 2_048, pattern: "^https://" }
  }
} as const;
const riskEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "reviewVersion", "reviewStatus", "reviewedDigestSha256", "classification", "hasScripts",
    "hasExternalUrls", "mcpDependencies", "declaredFileAccess", "allowImplicitInvocation"
  ],
  properties: {
    reviewVersion: { const: 1 },
    reviewStatus: { enum: ["unreviewed", "approved"] },
    reviewedDigestSha256: { anyOf: [{ type: "null" }, digest] },
    classification: { enum: ["instruction-only", "script-bearing"] },
    hasScripts: { type: "boolean" },
    hasExternalUrls: { type: "boolean" },
    externalOrigins: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: { type: "string", maxLength: 512, pattern: "^https?://" }
    },
    mcpDependencies: { type: "array", maxItems: 32, items: mcpDependencySchema },
    declaredFileAccess: {
      type: "array",
      maxItems: 3,
      uniqueItems: true,
      items: { enum: ["read", "write", "shell"] }
    },
    allowImplicitInvocation: { type: ["boolean", "null"] }
  }
} as const;
const skillSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "name", "description", "license", "compatibility", "metadata", "allowedTools", "riskEvidence",
    "enabled", "entry", "digestSha256",
    "fileCount", "unpackedBytes", "installedAt", "source"
  ],
  properties: {
    id: extensionId,
    name: extensionId,
    description: { type: "string", minLength: 1, maxLength: 1_024 },
    license: { type: ["string", "null"], minLength: 1, maxLength: 256 },
    compatibility: { type: ["string", "null"], minLength: 1, maxLength: 500 },
    metadata: {
      type: "object",
      maxProperties: 32,
      propertyNames: { pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$" },
      additionalProperties: { type: "string", maxLength: 256 }
    },
    allowedTools: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 128 }
    },
    riskEvidence: riskEvidenceSchema,
    enabled: { type: "boolean" },
    entry: { const: "SKILL.md" },
    digestSha256: digest,
    fileCount: { type: "integer", minimum: 1, maximum: 512 },
    unpackedBytes: { type: "integer", minimum: 1, maximum: 32 * 1024 * 1024 },
    installedAt: { type: "string", maxLength: 64 },
    source: sourceSchema,
    approval: {
      type: "object",
      additionalProperties: false,
      required: ["status", "digestSha256", "approvedAt"],
      properties: {
        status: { enum: ["unapproved", "approved"] },
        digestSha256: { anyOf: [{ type: "null" }, digest] },
        approvedAt: { type: ["string", "null"], maxLength: 64 }
      }
    }
  }
} as const;
const mcpPolicyProperties = {
  id: extensionId,
  name: { type: "string", minLength: 1, maxLength: 128 },
  description: { type: "string", maxLength: 1_024 },
  enabled: { type: "boolean" },
  required: { type: "boolean" },
  enabledTools: { type: "array", maxItems: 256, uniqueItems: true, items: { type: "string", maxLength: 128 } },
  disabledTools: { type: "array", maxItems: 256, uniqueItems: true, items: { type: "string", maxLength: 128 } },
  ordinaryUserTools: { type: "array", maxItems: 256, uniqueItems: true, items: { type: "string", maxLength: 128 } },
  approvalMode: { enum: ["always", "mutating", "never"] },
  migrationStatus: { const: "reauthorization_required" }
} as const;
const mcpServerSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "description", "enabled", "transport", "command", "args", "envKeys"],
      properties: {
        id: extensionId,
        name: mcpPolicyProperties.name,
        description: mcpPolicyProperties.description,
        enabled: mcpPolicyProperties.enabled,
        transport: { const: "stdio" },
        command: { type: "string", minLength: 1, maxLength: 512 },
        args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 1_024 } },
        envKeys: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", maxLength: 128 } },
        migrationStatus: mcpPolicyProperties.migrationStatus
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id", "name", "description", "enabled", "required", "enabledTools", "disabledTools", "approvalMode",
        "transport", "command", "args", "envKeys"
      ],
      properties: {
        ...mcpPolicyProperties,
        transport: { const: "stdio" },
        command: { type: "string", minLength: 1, maxLength: 512 },
        args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 1_024 } },
        envKeys: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", maxLength: 128 } }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id", "name", "description", "enabled", "required", "enabledTools", "disabledTools", "approvalMode",
        "transport", "url", "auth"
      ],
      properties: {
        ...mcpPolicyProperties,
        transport: { const: "streamable_http" },
        url: { type: "string", minLength: 1, maxLength: 2_048 },
        auth: {
          oneOf: [
            {
              type: "object", additionalProperties: false, required: ["kind"],
              properties: { kind: { const: "none" } }
            },
            {
              type: "object", additionalProperties: false, required: ["kind", "credentialRef"],
              properties: {
                kind: { enum: ["bearer", "oauth"] },
                credentialRef: { type: "string", minLength: 2, maxLength: 128 }
              }
            }
          ]
        }
      }
    }
  ]
} as const;
const mcpInstallPreviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "previewRevision", "server", "commandApproval"],
  properties: {
    schemaVersion: { const: 1 },
    previewRevision: digest,
    server: mcpServerSchema,
    commandApproval: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["required", "command", "args", "digestSha256"],
          properties: {
            required: { const: true },
            command: { type: "string", minLength: 1, maxLength: 512 },
            args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 1_024 } },
            digestSha256: digest
          }
        }
      ]
    }
  }
} as const;
const overviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "agentId", "skills", "mcp"],
  properties: {
    schemaVersion: { const: 1 },
    agentId,
    skills: { type: "array", items: skillSchema },
    mcp: {
      type: "object",
      additionalProperties: false,
      required: ["servers", "secrets"],
      properties: {
        servers: { type: "array", items: mcpServerSchema },
        secrets: secretStatusSchema
      }
    }
  }
} as const;
const agentQuery = {
  type: "object",
  additionalProperties: false,
  required: ["agentId"],
  properties: { agentId }
} as const;
const replaceProperty = { replace: { type: "boolean" } } as const;
const conflict = { enum: ["none", "same-content", "different-content"] } as const;
const skillFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "bytes", "sha256"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 240 },
    bytes: { type: "integer", minimum: 0, maximum: 8 * 1024 * 1024 },
    sha256: digest
  }
} as const;
const mcpPreviewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "server", "descriptorVersion", "conflict", "sourceSecrets", "targetSecrets",
    "targetState", "requiresAuthorization"
  ],
  properties: {
    server: mcpServerSchema,
    descriptorVersion: digest,
    conflict,
    sourceSecrets: secretStatusSchema,
    targetSecrets: secretStatusSchema,
    targetState: { const: "disabled" },
    requiresAuthorization: { type: "boolean" }
  }
} as const;
const copyPreviewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "previewRevision", "sourceAgentId", "targetAgentId",
    "sourceSkillRevision", "targetSkillRevision", "sourceMcpRevision", "targetMcpRevision",
    "skill", "selectedMcpServers"
  ],
  properties: {
    schemaVersion: { const: 1 },
    previewRevision: digest,
    sourceAgentId: agentId,
    targetAgentId: agentId,
    sourceSkillRevision: digest,
    targetSkillRevision: digest,
    sourceMcpRevision: digest,
    targetMcpRevision: digest,
    skill: {
      type: "object",
      additionalProperties: false,
      required: [
        "record", "contentVersion", "files", "conflict",
        "declaredMcpDependencies", "declaredMcpDependenciesStatus", "missingMcpDependencies"
      ],
      properties: {
        record: skillSchema,
        contentVersion: digest,
        files: { type: "array", minItems: 1, maxItems: 512, items: skillFileSchema },
        conflict,
        declaredMcpDependencies: { type: "array", maxItems: 32, items: mcpDependencySchema },
        declaredMcpDependenciesStatus: { enum: ["none", "declared", "missing"] },
        missingMcpDependencies: { type: "array", maxItems: 32, uniqueItems: true, items: extensionId }
      }
    },
    selectedMcpServers: { type: "array", maxItems: 128, items: mcpPreviewSchema }
  }
} as const;
const copyApplySchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "sourceAgentId", "targetAgentId", "skill", "skipped", "mcpServers"],
  properties: {
    schemaVersion: { const: 1 },
    sourceAgentId: agentId,
    targetAgentId: agentId,
    skill: { anyOf: [{ type: "null" }, skillSchema] },
    skipped: { type: "boolean" },
    mcpServers: { type: "array", maxItems: 128, items: mcpServerSchema }
  }
} as const;

export function registerAgentExtensionRoutes(app: FastifyInstance, options: AgentExtensionRouteOptions) {
  const guarded = { preHandler: options.adminGuard };

  app.get("/api/agent-extensions", {
    ...guarded,
    preValidation: strictRequestObject("query", ["agentId"]),
    schema: { querystring: agentQuery, response: { 200: overviewSchema } }
  }, async (request) => options.service.overview(field(request.query, "agentId")));

  app.post("/api/agent-extensions/skills", {
    ...guarded,
    preValidation: strictRequestObject("body", ["agentId", "archiveBase64", "replace"]),
    bodyLimit: Math.ceil(MAX_SKILL_ARCHIVE_BYTES * 1.4) + 4_096,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "archiveBase64"],
        properties: {
          agentId,
          archiveBase64: { type: "string", minLength: 4, maxLength: Math.ceil(MAX_SKILL_ARCHIVE_BYTES / 3) * 4 },
          ...replaceProperty
        }
      },
      response: { 201: skillSchema }
    }
  }, async (request, reply) => {
    const body = objectBody(request.body);
    const skill = await options.service.installSkill({
      agentId: body.agentId,
      archive: decodeBase64(body.archiveBase64),
      replace: body.replace
    });
    await options.onAgentExtensionsChanged?.(stringField(body.agentId));
    return reply.status(201).send(skill);
  });

  app.post("/api/agent-extensions/skills/:skillId/review", {
    ...guarded,
    preValidation: combineStrictObjects([
      ["params", ["skillId"]],
      ["body", ["agentId", "approve"]]
    ]),
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["skillId"],
        properties: { skillId: extensionId }
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "approve"],
        properties: { agentId, approve: { const: true } }
      },
      response: { 200: skillSchema }
    }
  }, async (request) => {
    const targetAgentId = stringField(field(request.body, "agentId"));
    const result = await options.service.reviewSkill({
      agentId: targetAgentId,
      skillId: field(request.params, "skillId"),
      approve: field(request.body, "approve")
    });
    await options.onAgentExtensionsChanged?.(targetAgentId);
    return result;
  });

  app.post("/api/agent-extensions/skills/copy/preview", {
    ...guarded,
    preValidation: strictRequestObject("body", [
      "sourceAgentId", "targetAgentId", "skillId", "mcpServerIds"
    ]),
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["sourceAgentId", "targetAgentId", "skillId"],
        properties: {
          sourceAgentId: agentId,
          targetAgentId: agentId,
          skillId: extensionId,
          mcpServerIds: {
            type: "array",
            maxItems: 128,
            uniqueItems: true,
            items: extensionId
          }
        }
      },
      response: { 200: copyPreviewSchema }
    }
  }, async (request) => options.service.previewCopy(objectBody(request.body) as {
    sourceAgentId: unknown;
    targetAgentId: unknown;
    skillId: unknown;
    mcpServerIds?: unknown;
  }));

  app.post("/api/agent-extensions/skills/copy", {
    ...guarded,
    preValidation: strictRequestObject("body", [
      "sourceAgentId", "targetAgentId", "skillId", "mcpServerIds", "previewRevision",
      "conflictStrategy", "renameTo"
    ]),
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["sourceAgentId", "targetAgentId", "skillId", "previewRevision", "conflictStrategy"],
        properties: {
          sourceAgentId: agentId,
          targetAgentId: agentId,
          skillId: extensionId,
          mcpServerIds: { type: "array", maxItems: 128, uniqueItems: true, items: extensionId },
          previewRevision: digest,
          conflictStrategy: { enum: ["skip", "replace", "rename"] },
          renameTo: extensionId
        }
      },
      response: { 200: copyApplySchema }
    }
  }, async (request) => {
    const result = await options.service.applyCopy(objectBody(request.body) as {
      sourceAgentId: unknown;
      targetAgentId: unknown;
      skillId: unknown;
      mcpServerIds?: unknown;
      previewRevision: unknown;
      conflictStrategy: unknown;
      renameTo?: unknown;
    });
    await options.onAgentExtensionsChanged?.(result.targetAgentId);
    return result;
  });

  app.patch("/api/agent-extensions/skills/:skillId", {
    ...guarded,
    preValidation: combineStrictObjects([
      ["params", ["skillId"]],
      ["body", ["agentId", "enabled"]]
    ]),
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["skillId"],
        properties: { skillId: extensionId }
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "enabled"],
        properties: { agentId, enabled: { type: "boolean" } }
      },
      response: { 200: skillSchema }
    }
  }, async (request) => {
    const targetAgentId = stringField(field(request.body, "agentId"));
    const result = await options.service.setSkillEnabled({
      agentId: targetAgentId,
      skillId: field(request.params, "skillId"),
      enabled: field(request.body, "enabled")
    });
    await options.onAgentExtensionsChanged?.(targetAgentId);
    return result;
  });

  app.delete("/api/agent-extensions/skills/:skillId", {
    ...guarded,
    preValidation: combineStrictObjects([
      ["params", ["skillId"]],
      ["query", ["agentId"]]
    ]),
    schema: {
      params: {
        type: "object",
        additionalProperties: false,
        required: ["skillId"],
        properties: { skillId: extensionId }
      },
      querystring: agentQuery,
      response: { 200: skillSchema }
    }
  }, async (request) => {
    const targetAgentId = stringField(field(request.query, "agentId"));
    const result = await options.service.uninstallSkill({
      agentId: targetAgentId,
      skillId: field(request.params, "skillId")
    });
    await options.onAgentExtensionsChanged?.(targetAgentId);
    return result;
  });

  app.post("/api/agent-extensions/mcp/servers/preview", {
    ...guarded,
    preValidation: strictRequestObject("body", ["agentId", "server"]),
    schema: {
      body: {
        type: "object", additionalProperties: false, required: ["agentId", "server"],
        properties: { agentId, server: mcpServerSchema }
      },
      response: { 200: mcpInstallPreviewSchema }
    }
  }, async (request) => {
    const body = objectBody(request.body);
    return options.service.previewMcpServer({ agentId: body.agentId, server: body.server });
  });

  app.put("/api/agent-extensions/mcp/servers", {
    ...guarded,
    preValidation: strictRequestObject(
      "body",
      ["agentId", "server", "replace", "previewRevision", "approveCommand"]
    ),
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "server", "previewRevision", "approveCommand"],
        properties: {
          agentId,
          server: mcpServerSchema,
          ...replaceProperty,
          previewRevision: digest,
          approveCommand: { type: "boolean" }
        }
      },
      response: { 200: mcpServerSchema }
    }
  }, async (request) => {
    const body = objectBody(request.body);
    const result = await options.service.putMcpServer({
      agentId: body.agentId,
      server: body.server,
      replace: body.replace,
      previewRevision: body.previewRevision,
      approveCommand: body.approveCommand
    });
    await options.onAgentExtensionsChanged?.(stringField(body.agentId));
    return result;
  });

  app.patch("/api/agent-extensions/mcp/servers/:serverId", {
    ...guarded,
    preValidation: combineStrictObjects([
      ["params", ["serverId"]],
      ["body", ["agentId", "enabled"]]
    ]),
    schema: {
      params: {
        type: "object", additionalProperties: false, required: ["serverId"],
        properties: { serverId: extensionId }
      },
      body: {
        type: "object", additionalProperties: false, required: ["agentId", "enabled"],
        properties: { agentId, enabled: { type: "boolean" } }
      },
      response: { 200: mcpServerSchema }
    }
  }, async (request) => {
    const targetAgentId = stringField(field(request.body, "agentId"));
    const result = await options.service.setMcpServerEnabled({
      agentId: targetAgentId,
      serverId: field(request.params, "serverId"),
      enabled: field(request.body, "enabled")
    });
    await options.onAgentExtensionsChanged?.(targetAgentId);
    return result;
  });

  app.delete("/api/agent-extensions/mcp/servers/:serverId", {
    ...guarded,
    preValidation: combineStrictObjects([
      ["params", ["serverId"]],
      ["query", ["agentId"]]
    ]),
    schema: {
      params: {
        type: "object", additionalProperties: false, required: ["serverId"],
        properties: { serverId: extensionId }
      },
      querystring: agentQuery,
      response: { 200: mcpServerSchema }
    }
  }, async (request) => {
    const targetAgentId = stringField(field(request.query, "agentId"));
    const result = await options.service.removeMcpServer({
      agentId: targetAgentId,
      serverId: field(request.params, "serverId")
    });
    await options.onAgentExtensionsChanged?.(targetAgentId);
    return result;
  });

}

function objectBody(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function field(value: unknown, name: string) {
  return objectBody(value)[name];
}

function stringField(value: unknown) {
  if (typeof value !== "string") {
    throw new AgentExtensionServiceError(400, "AGENT_EXTENSION_REQUEST_INVALID", "请求字段无效。");
  }
  return value;
}

function decodeBase64(value: unknown) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new AgentExtensionServiceError(400, "SKILL_ARCHIVE_BASE64_INVALID", "Skill ZIP Base64 无效。");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > MAX_SKILL_ARCHIVE_BYTES) {
    throw new AgentExtensionServiceError(400, "SKILL_ARCHIVE_BASE64_INVALID", "Skill ZIP Base64 无效。");
  }
  return bytes;
}

type RequestLocation = "body" | "query" | "params";

function strictRequestObject(location: RequestLocation, allowed: string[]) {
  return async (request: { body: unknown; query: unknown; params: unknown }) => {
    strictObjectKeys(request[location], allowed);
  };
}

function combineStrictObjects(entries: Array<[RequestLocation, string[]]>) {
  return async (request: { body: unknown; query: unknown; params: unknown }) => {
    for (const [location, allowed] of entries) strictObjectKeys(request[location], allowed);
  };
}

function strictObjectKeys(value: unknown, allowed: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new AgentExtensionServiceError(400, "AGENT_EXTENSION_REQUEST_INVALID", "请求字段无效。");
  }
}
