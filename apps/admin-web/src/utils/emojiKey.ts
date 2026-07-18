export function normalizeEmojiKey(value: string) {
  return value.normalize("NFC").trim();
}

export function emojiKeyValidationError(value: string) {
  if (hasInvalidUnicode(value)) return "表情名称包含无效字符";
  if (/[\u0000-\u001f\u007f-\u009f\[\]\/\\]/u.test(value)) {
    return "表情名称不能包含括号、斜杠或控制字符";
  }
  const key = normalizeEmojiKey(value);
  if (!key) return "请输入表情名称";
  if ([...key].length > 24 || new TextEncoder().encode(key).length > 64) {
    return "表情名称不能超过 24 个字符";
  }
  return "";
}

function hasInvalidUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0xfffd) return true;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}
