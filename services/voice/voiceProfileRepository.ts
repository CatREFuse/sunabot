import path from "node:path";
import {
  ensureVoiceLayout,
  publishVoiceReference,
  readRuntimeVoiceReference,
  readStoredVoiceProfile,
  removeVoiceReferenceBlob,
  runWithVoiceWorkspaceLock,
  writeStoredVoiceProfile,
  type VoiceWorkspaceContext,
} from "./voiceProfileStorage.js";
import {
  REFERENCE_DIRECTORY,
  VOICE_DIRECTORY,
  parseVoiceLanguage,
  parseVoiceProfileSettings,
  parseVoiceProviderSettings,
  parseVoiceReferenceUpload,
  profileUsesRelativePath,
  safeVoiceReferenceStem,
} from "./voiceProfileValidation.js";
import {
  VoiceProfileError,
  type RuntimeVoiceReference,
  type RuntimeVoiceTarget,
  type VoiceLanguage,
  type VoiceProfileSettingsInput,
  type VoiceProfileV1,
  type VoiceProviderSettingsInput,
  type VoiceReferenceMetadata,
  type VoiceReferenceUpload,
} from "./types.js";

export interface VoiceProfileRepositoryOptions {
  agentWorkspace: string;
  now?: () => Date;
}

export class VoiceProfileRepository {
  private readonly requestedWorkspace: string;
  private readonly now: () => Date;

  constructor(options: string | VoiceProfileRepositoryOptions) {
    const agentWorkspace =
      typeof options === "string" ? options : options.agentWorkspace;
    if (
      typeof agentWorkspace !== "string" ||
      !path.isAbsolute(agentWorkspace) ||
      path.parse(agentWorkspace).root === path.resolve(agentWorkspace)
    ) {
      throw new VoiceProfileError(
        "VOICE_WORKSPACE_INVALID",
        "Agent 语音目录不可用。",
        500,
      );
    }
    this.requestedWorkspace = path.resolve(agentWorkspace);
    this.now =
      typeof options === "string"
        ? () => new Date()
        : (options.now ?? (() => new Date()));
  }

  readProfile(): Promise<VoiceProfileV1> {
    return this.withWorkspaceLock(async (workspace) =>
      readStoredVoiceProfile(workspace),
    );
  }

  updateSettings(input: VoiceProfileSettingsInput): Promise<VoiceProfileV1> {
    const settings = parseVoiceProfileSettings(input);
    return this.withWorkspaceLock(async (workspace) => {
      const current = await readStoredVoiceProfile(workspace);
      if (
        settings.enabled &&
        !current.provider.voices[settings.defaultLanguage]
      ) {
        throw new VoiceProfileError(
          "VOICE_DEFAULT_VOICE_REQUIRED",
          "启用语音前需要为默认语言设置在线音色 ID。",
          409,
        );
      }
      const next: VoiceProfileV1 = { ...current, ...settings };
      await writeStoredVoiceProfile(workspace, next);
      return next;
    });
  }

  updateProvider(input: VoiceProviderSettingsInput): Promise<VoiceProfileV1> {
    const provider = parseVoiceProviderSettings(input);
    return this.withWorkspaceLock(async (workspace) => {
      const current = await readStoredVoiceProfile(workspace);
      if (current.enabled && !provider.voices[current.defaultLanguage]) {
        throw new VoiceProfileError(
          "VOICE_DEFAULT_VOICE_REQUIRED",
          "默认语言需要设置在线音色 ID。",
          409,
        );
      }
      const next: VoiceProfileV1 = { ...current, provider };
      await writeStoredVoiceProfile(workspace, next);
      return next;
    });
  }

  putReference(input: VoiceReferenceUpload): Promise<VoiceProfileV1> {
    return this.withWorkspaceLock(async (workspace) => {
      const upload = await parseVoiceReferenceUpload(input, this.now);
      const current = await readStoredVoiceProfile(workspace);
      const layout = await ensureVoiceLayout(workspace, true);
      const storedFileName = `${safeVoiceReferenceStem(upload.fileName)}-${upload.detected.sha256}.${upload.detected.extension}`;
      const relativePath = path.posix.join(
        VOICE_DIRECTORY,
        REFERENCE_DIRECTORY,
        storedFileName,
      );
      const storedPath = path.join(layout.referencesDirectory, storedFileName);
      await publishVoiceReference(
        storedPath,
        layout.referencesDirectory,
        upload.bytes,
      );

      const metadata: VoiceReferenceMetadata = {
        language: upload.language,
        fileName: upload.fileName,
        relativePath,
        mimeType: upload.detected.mimeType,
        sizeBytes: upload.bytes.byteLength,
        sha256: upload.detected.sha256,
        referenceText: upload.referenceText,
        ...(upload.sourceUrl ? { sourceUrl: upload.sourceUrl } : {}),
        ...(upload.characterUrl ? { characterUrl: upload.characterUrl } : {}),
        updatedAt: upload.updatedAt,
      };
      const previous = current.languages[upload.language];
      const next: VoiceProfileV1 = {
        ...current,
        languages: { ...current.languages, [upload.language]: metadata },
      };

      try {
        await writeStoredVoiceProfile(workspace, next);
      } catch (error) {
        if (!profileUsesRelativePath(current, relativePath)) {
          await removeVoiceReferenceBlob(workspace, metadata).catch(
            () => undefined,
          );
        }
        throw error;
      }
      if (
        previous &&
        previous.relativePath !== relativePath &&
        !profileUsesRelativePath(next, previous.relativePath)
      ) {
        await removeVoiceReferenceBlob(workspace, previous).catch(
          () => undefined,
        );
      }
      return next;
    });
  }

  removeReference(language: VoiceLanguage): Promise<VoiceProfileV1> {
    const selectedLanguage = parseVoiceLanguage(language);
    return this.withWorkspaceLock(async (workspace) => {
      const current = await readStoredVoiceProfile(workspace);
      const previous = current.languages[selectedLanguage];
      if (!previous) {
        throw new VoiceProfileError(
          "VOICE_REFERENCE_NOT_FOUND",
          "该语言尚未设置参考音频。",
          404,
        );
      }
      const next: VoiceProfileV1 = {
        ...current,
        languages: { ...current.languages, [selectedLanguage]: null },
      };
      await writeStoredVoiceProfile(workspace, next);
      if (!profileUsesRelativePath(next, previous.relativePath)) {
        await removeVoiceReferenceBlob(workspace, previous).catch(
          () => undefined,
        );
      }
      return next;
    });
  }

  readReference(language: VoiceLanguage): Promise<RuntimeVoiceReference> {
    const selectedLanguage = parseVoiceLanguage(language);
    return this.withWorkspaceLock(async (workspace) => {
      const profile = await readStoredVoiceProfile(workspace);
      return readRuntimeVoiceReference(workspace, profile, selectedLanguage);
    });
  }

  readRuntimeProfile(language?: VoiceLanguage): Promise<RuntimeVoiceTarget> {
    const selectedLanguage =
      language === undefined ? undefined : parseVoiceLanguage(language);
    return this.withWorkspaceLock(async (workspace) => {
      const profile = await readStoredVoiceProfile(workspace);
      if (!profile.enabled) {
        throw new VoiceProfileError("VOICE_DISABLED", "语音功能未启用。", 409);
      }
      const resolvedLanguage = selectedLanguage ?? profile.defaultLanguage;
      const voiceId = profile.provider.voices[resolvedLanguage];
      if (!voiceId) {
        throw new VoiceProfileError(
          "VOICE_DEFAULT_VOICE_REQUIRED",
          "该语言尚未设置在线音色 ID。",
          409,
        );
      }
      return {
        profile,
        language: resolvedLanguage,
        voiceId,
        provider: profile.provider,
      };
    });
  }

  private withWorkspaceLock<T>(
    operation: (workspace: VoiceWorkspaceContext) => Promise<T>,
  ): Promise<T> {
    return runWithVoiceWorkspaceLock(this.requestedWorkspace, operation);
  }
}
