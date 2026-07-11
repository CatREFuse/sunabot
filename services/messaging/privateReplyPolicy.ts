const QQ_PATTERN = /^\d{5,12}$/;

export function isPrivateReplyAllowed(
  userId: number | string,
  configured = process.env.SUNABOT_PRIVATE_REPLY_ALLOWLIST
) {
  const raw = configured?.trim();
  if (!raw) return true;
  const allowed = raw.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  if (allowed.length === 0 || allowed.some((value) => !QQ_PATTERN.test(value))) return false;
  return allowed.includes(String(userId));
}
