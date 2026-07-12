import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

export async function configureNapcatClient(options) {
  const configDir = path.resolve(options.configDir);
  const env = dotenv.parse(await fs.readFile(options.secretsPath, "utf8"));
  const token = env.ONEBOT_ACCESS_TOKEN?.trim();
  if (!token) throw new Error(`${options.secretsLabel ?? options.secretsPath} 缺少 ONEBOT_ACCESS_TOKEN。`);
  const account = env.NAPCAT_ACCOUNT?.trim();

  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  let names = (await fs.readdir(configDir))
    .filter((name) => /^onebot11(?:_\d+)?\.json$/.test(name));
  if (names.length === 0) {
    names = account && /^\d{5,12}$/.test(account)
      ? [`onebot11_${account}.json`]
      : ["onebot11.json"];
  }

  for (const name of names) {
    const filePath = path.join(configDir, name);
    const config = await readJsonOrDefault(filePath, { network: { websocketClients: [] } });
    const clients = Array.isArray(config.network?.websocketClients)
      ? config.network.websocketClients
      : [];
    const template = clients.find((item) => item?.name === "sunabot")
      ?? clients[0]
      ?? {};
    const client = {
      ...template,
      name: "sunabot",
      enable: true,
      url: options.onebotReverseWebSocket,
      messagePostFormat: "array",
      reportSelfMessage: false,
      reconnectInterval: 5000,
      token,
      debug: false,
      heartInterval: 30000
    };
    config.network ??= {};
    config.enableLocalFile2Url = true;
    config.network.websocketClients = [client];
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, filePath);
  }

  return { configDir, names };
}

async function readJsonOrDefault(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return structuredClone(fallback);
  }
}
