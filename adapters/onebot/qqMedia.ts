const TRUSTED_QQ_MEDIA_HOSTNAMES = [
  "multimedia.nt.qq.com.cn",
  "grouptalk.c2c.qq.com",
  "ftn.qq.com",
  "q1.qlogo.cn",
  "p.qlogo.cn"
] as const;

export function isTrustedQqMediaHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return TRUSTED_QQ_MEDIA_HOSTNAMES.some((trusted) =>
    normalized === trusted || normalized.endsWith(`.${trusted}`));
}

export function isTrustedQqFakeIp(hostname: string, address: string) {
  if (!isTrustedQqMediaHostname(hostname)) return false;
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets[0] === 198 &&
    (octets[1] === 18 || octets[1] === 19) &&
    octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
}
