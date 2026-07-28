import crypto from "node:crypto";
import fs from "node:fs";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_TOKEN_INPUT_BYTES = 128;

export function readRendererAuthToken(environment: NodeJS.ProcessEnv = process.env) {
  const direct = environment.SUNABOT_WEBFETCH_RENDERER_TOKEN?.trim();
  const rawFd = environment.SUNABOT_WEBFETCH_RENDERER_TOKEN_FD?.trim();
  delete environment.SUNABOT_WEBFETCH_RENDERER_TOKEN;
  delete environment.SUNABOT_WEBFETCH_RENDERER_TOKEN_FD;
  if (direct && rawFd) throw new Error("WEBFETCH_RENDERER_AUTH_INVALID");
  if (direct) return validateRendererAuthToken(direct);
  if (!rawFd) throw new Error("WEBFETCH_RENDERER_AUTH_REQUIRED");
  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 64) {
    throw new Error("WEBFETCH_RENDERER_AUTH_INVALID");
  }
  let value = "";
  try {
    const buffer = Buffer.alloc(MAX_TOKEN_INPUT_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
    value = buffer.subarray(0, bytes).toString("utf8").trim();
    buffer.fill(0);
  } finally {
    fs.closeSync(fd);
  }
  return validateRendererAuthToken(value);
}

export function validateRendererAuthToken(value: string) {
  if (!TOKEN_PATTERN.test(value)) throw new Error("WEBFETCH_RENDERER_AUTH_INVALID");
  const decoded = Buffer.from(value, "base64url");
  try {
    if (decoded.length !== TOKEN_BYTES) throw new Error("WEBFETCH_RENDERER_AUTH_INVALID");
  } finally {
    decoded.fill(0);
  }
  return value;
}

export function rendererRequestAuthorized(
  authorization: string | string[] | undefined,
  expectedToken: string
) {
  if (Array.isArray(authorization) || typeof authorization !== "string") return false;
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  const supplied = authorization.slice(prefix.length);
  if (!TOKEN_PATTERN.test(supplied)) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expectedToken);
  try {
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } finally {
    left.fill(0);
    right.fill(0);
  }
}
