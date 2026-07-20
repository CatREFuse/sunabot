import type { PromptVariableValue } from "../agent/public.js";
import { VOICE_LANGUAGES, type VoiceProfileV1 } from "./types.js";

export const VOICE_TRIGGER_POLICY = [
  "语音只用于少量具有标志性或强烈情绪意义的表达，包括早安、晚安、喜爱与亲密表达、强烈兴奋、生气或委屈、害羞，以及重要里程碑。",
  "日常事实、普通问答、任务进度、错误说明、代码、命令、URL 和长内容不要调用语音。",
  "语音不能替代文字；每份同源文字至多伴生一次语音。send_voice_message.text 必须与当前回复中的可见 text、assistant_text.text 或异步工具 dispatch_message 的可读正文一致，表情标记不读出。assistant_text 已在本轮成功发送时，下一次模型响应可以只调用一次 send_voice_message。",
  "send_voice_message 只传需要朗读的正文；合成语言和参考音频始终由当前 Voice Profile 的默认语言决定，不受主会话语言限制，也不要为了参考音频语言改写正文。没有可用参考音频或语音已关闭时不要调用。",
].join("\n");

export function voicePromptVariables(
  profile: VoiceProfileV1,
): Record<string, PromptVariableValue> {
  return {
    "conversation.voice.settings": {
      enabled: profile.enabled,
      defaultLanguage: profile.defaultLanguage,
      languages: VOICE_LANGUAGES.map((code) => ({
        code,
        label: languageLabel(code),
        referenceReady: profile.languages[code] !== null,
      })),
    },
    "conversation.voice.trigger_policy": VOICE_TRIGGER_POLICY,
  };
}

function languageLabel(code: (typeof VOICE_LANGUAGES)[number]) {
  if (code === "zh") return "中文";
  if (code === "en") return "English";
  return "日本語";
}
