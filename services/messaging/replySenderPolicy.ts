const QQ_PATTERN = /^\d{5,12}$/;

export function isReplySenderAllowed(
  userId: number | string,
  adminQq: string | undefined
) {
  const sender = String(userId).trim();
  const admin = adminQq?.trim() ?? "";
  if (!QQ_PATTERN.test(sender) || !QQ_PATTERN.test(admin)) return false;
  return sender === admin;
}
