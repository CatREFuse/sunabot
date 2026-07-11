export interface RawProviderConfig {
  id: string;
  label?: string;
  kind: string;
  enabled: boolean;
  model: string;
  apiKeyEnv: string;
  envFile?: string;
}

export interface RawSmokeConfig {
  providers: {
    defaultProviderId: string;
    items: RawProviderConfig[];
  };
  bot: {
    adminQq: string;
  };
  onebot: {
    reverseWsPath: string;
    accessTokenEnv: string;
  };
}

export interface RuntimeLayout {
  config: string;
  secrets: string;
  napcatConfig: string;
  napcatQrCode: string;
}

export interface SmokeContext {
  root: string;
  workspace: string;
  configPath: string;
  config: RawSmokeConfig;
  provider: RawProviderConfig;
  providerEnvPath: string;
  providerToken: string;
  onebotToken: string;
  adminQq: string;
  napcatAccount: string;
  onebotPort: number;
  onebotPath: string;
  onebotUrl: string;
  layout: RuntimeLayout;
}

export interface LoadContextOptions {
  requireProviderCredential?: boolean;
  requireOneBotCredential?: boolean;
  requireNapCatConfig?: boolean;
}

export interface ActionResponseOptions {
  expectedEcho: string;
  requireMessageId?: boolean;
  requireUserId?: boolean;
}
