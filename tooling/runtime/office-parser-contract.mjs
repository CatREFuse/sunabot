const OFFICEPARSER_LOCK_PATH = "node_modules/officeparser";

export function validateOfficeParserContract({ componentLock, packageManifest, packageLock }) {
  const errors = [];
  const officeParser = componentLock.components?.officeparser;
  const lockedPackage = packageLock.packages?.[OFFICEPARSER_LOCK_PATH];
  const declaredDependency = packageManifest.dependencies?.officeparser;
  const lockedRootDependency = packageLock.packages?.[""]?.dependencies?.officeparser;

  expect(officeParser?.package === "officeparser", "Office parser component must name officeparser");
  expect(typeof officeParser?.version === "string" && officeParser.version.length > 0,
    "Office parser component must pin a version");
  expect(typeof officeParser?.integrity === "string" && /^sha512-[A-Za-z0-9+/]+=*$/.test(officeParser.integrity),
    "Office parser component must pin sha512 integrity");
  expect(lockedPackage?.version === officeParser?.version,
    "package-lock officeparser version must match the component lock");
  expect(lockedPackage?.integrity === officeParser?.integrity,
    "package-lock officeparser integrity must match the component lock");
  expect(lockedRootDependency === declaredDependency,
    "package-lock root officeparser dependency must match package.json");
  expect(packageManifest.scripts?.["office:read"] === "officeparser",
    "Office parser must expose the non-GUI CLI");

  return errors;

  function expect(condition, message) {
    if (!condition) errors.push(message);
  }
}
