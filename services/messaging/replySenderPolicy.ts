const QQ_PATTERN = /^\d{5,12}$/;

export function isReplySenderAllowed(
  userId: number | string,
  _adminQq?: string | undefined
) {
  const sender = String(userId).trim();
  return QQ_PATTERN.test(sender);
}

export function isAdminSender(
  userId: number | string,
  adminQq: string | undefined
) {
  const sender = String(userId).trim();
  const admin = adminQq?.trim() ?? "";
  return QQ_PATTERN.test(sender) && QQ_PATTERN.test(admin) && sender === admin;
}
