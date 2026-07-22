export const TONE_OUTPUT_CONTRACT_VARIABLE = "tone.output_contract";
export const TONE_AVAILABLE_ASSETS_VARIABLE = "tone.available_assets";
export const TONE_MODE_VARIABLE = "tone_mode";

export type ToneAvailableAssetKind = "image" | "voice" | "file";

export interface ToneAvailableAssetV1 {
  kind: ToneAvailableAssetKind;
  src: string;
}

export const TONE_OUTPUT_VARIABLE_BLOCK = [
  `<tone_output_contract>@{${TONE_OUTPUT_CONTRACT_VARIABLE}}</tone_output_contract>`,
  `<tone_available_assets>@{${TONE_AVAILABLE_ASSETS_VARIABLE}}</tone_available_assets>`
].join("\n");

export const TONE_XML_REVIEW_RULE = [
  `<xml-check s-if="${TONE_MODE_VARIABLE} == true">`,
  "原始发言中的 XML 草稿会原样进入 Tone，不要在改写前拒绝或复述格式错误；你必须在本节点完成检查和订正。",
  "检查并订正所有 XML：只保留 tone_output_contract 规定的标签、属性、顺序、表情标记和媒体句柄，正文事实、代码、命令、数字与原始顺序不得丢失或改写。",
  "发现嵌套标签时必须展开为合法的顶层节点；发现 <br/> 或其他未规定的 XML/HTML 标签时，用普通换行、实体转义或新的顶层文字节点表达其原有内容，绝对不可把未规定标签带入最终输出。",
  "最终输出前再次逐项核对 tone_output_contract；订正后的结果必须与宿主校验规则完全一致。",
  "</xml-check>"
].join("\n");

export const PLAIN_TONE_OUTPUT_CONTRACT = [
  "只输出改写后的完整发言，不要输出解释、标题、标签、引号、Markdown 包裹或额外内容。",
  "逐字保留原始发言中已有的表情标记及其原始位置，不得为 key 添加前缀或改写 key。",
  "原始发言以“异常：”开头时，该完整发言是必须传递给用户核对的错误原文；必须逐字完整保留，可以在前面补充自然说明，但不得改写、概括、翻译、删除或用泛化提示替代错误原文。",
  "原始发言中已有的“（错误：…）”属于正文，必须逐字保留；新确认的非阻断错误也只能按该格式追加在正文末尾。"
].join("\n");

export const SEGMENTED_TONE_OUTPUT_CONTRACT = [
  "只输出 XML 片段，不要输出根标签、解释、Markdown 或标签外文本。",
  "允许的 XML 标签严格限定为 dialogc、dialog、exp、img、voice、file；不得使用规定之外的任何 XML 或 HTML 标签。",
  '第一个文字气泡使用 <dialogc replay="msg_id">文字</dialogc>，后续文字气泡使用 <dialog>文字</dialog>。',
  "只有本轮明确允许的表情标记才能按原顺序输出为独立的 <exp>；不得为 key 添加前缀，不得新增、删除、改写或重排。",
  '图片、语音和文件分别使用 <img src="..."/>、<voice src="..."/>、<file src="..."/>。',
  "src 只能逐字使用 tone_available_assets 中提供的值，每个资源必须按原顺序恰好输出一次。",
  "所有节点必须平铺在顶层，每个顶层 XML 节点对应一个聊天气泡；任何节点内绝对不可嵌套标签，包括 <br/>、HTML 标签或本合同允许的其他标签。",
  "需要保留换行时只能使用普通换行文本或拆成新的顶层文字节点，绝对不可用标签表示换行。",
  "原始发言以“异常：”开头时，该完整发言是必须传递给用户核对的错误原文；必须逐字完整保留在文字气泡中，不得改写、概括、翻译、删除或用泛化提示替代。",
  "原始发言中已有或本节点新追加的“（错误：…）”必须位于最后一个文字气泡内，不得放在 XML 标签外。",
  "XML 文本中的 &、<、>、双引号和单引号必须使用实体转义。"
].join("\n");

export function segmentedToneOutputContract(markers: readonly string[]) {
  if (markers.length > 4 || markers.some((marker) => !/^\[\/[^\]\r\n]{1,64}\]$/u.test(marker))) {
    throw toneAssetError("Tone 表情标记无效。");
  }
  return [
    SEGMENTED_TONE_OUTPUT_CONTRACT,
    `本轮允许输出为 <exp> 的表情标记依次为 ${JSON.stringify(markers)}；只能逐字使用该列表中的值。列表为空时不得输出 <exp>；其他形似标记的正文必须保留在文字气泡中。`
  ].join("\n");
}

export function serializeToneAvailableAssets(assets: readonly ToneAvailableAssetV1[]) {
  if (assets.length > 32) throw toneAssetError("Tone 可用媒体超过数量限制。");
  const seen = new Set<string>();
  return JSON.stringify(assets.map((asset) => {
    if (!/^(image|voice|file)$/u.test(asset.kind)
      || !new RegExp(`^asset:${asset.kind}:[0-9]+$`, "u").test(asset.src)
      || seen.has(asset.src)) {
      throw toneAssetError("Tone 可用媒体句柄无效。");
    }
    seen.add(asset.src);
    return { kind: asset.kind, src: asset.src };
  }));
}

function toneAssetError(message: string) {
  return Object.assign(new Error(message), { code: "TONE_ASSET_HANDLE_INVALID" });
}
