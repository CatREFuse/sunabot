export function displayMessageText(
  text: string,
  imageUrls: readonly string[] | undefined,
  memberNames: Readonly<Record<string, string>> = {}
) {
  if (imageUrls?.length && text.trim() === "[图片]") return "";
  return text.replace(/@(\d{5,12})\b/g, (mention, qq: string) => {
    const name = String(memberNames[qq] ?? "").trim();
    if (!name || name === qq || /^QQ\s+\d+$/i.test(name)) return mention;
    return `@${name} (${qq})`;
  });
}
