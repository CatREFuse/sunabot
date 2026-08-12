const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class StrictBase64Error extends Error {
  constructor(readonly reason: "invalid" | "too_large") {
    super(
      reason === "too_large"
        ? "Base64 payload is too large."
        : "Base64 payload is invalid.",
    );
    this.name = "StrictBase64Error";
  }
}

export function decodeStrictBase64(value: unknown, maxBytes: number) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new StrictBase64Error("invalid");
  }
  const decodedBytes = decodedBase64Size(value);
  if (decodedBytes <= 0) throw new StrictBase64Error("invalid");
  if (decodedBytes > maxBytes) throw new StrictBase64Error("too_large");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== decodedBytes || bytes.toString("base64") !== value) {
    throw new StrictBase64Error("invalid");
  }
  return bytes;
}

function decodedBase64Size(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
