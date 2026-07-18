import {
  OfficeParser,
  type OfficeContentNode,
  type SupportedFileType
} from "officeparser";

const MAX_OFFICE_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_OFFICE_ZIP_ENTRIES = 20_000;

export interface OfficeTextSection {
  index: number;
  kind: "slide" | "sheet" | "page" | "section";
  title: string;
  text: string;
}

export interface OfficeTextExtraction {
  fileType: SupportedFileType;
  sections: OfficeTextSection[];
  pageCount?: number;
  textCharacterCount: number;
  warnings: Array<{ code?: string; message: string }>;
}

export async function extractOfficeText(filePath: string): Promise<OfficeTextExtraction> {
  const warnings: Array<{ code?: unknown; message: string }> = [];
  const ast = await OfficeParser.parseOffice(filePath, {
    extractAttachments: false,
    includeRawContent: false,
    ignoreSlideMasters: true,
    onWarning: (warning) => warnings.push(warning),
    decompressionLimits: {
      maxUncompressedBytes: MAX_OFFICE_UNCOMPRESSED_BYTES,
      maxZipEntries: MAX_OFFICE_ZIP_ENTRIES
    }
  });

  const sections = ast.content.flatMap((node, index) => {
    const text = normalizeOfficeText(node.text || collectNodeText(node));
    if (!text) return [];
    return [{
      index,
      kind: officeSectionKind(node.type),
      title: officeSectionTitle(node, index),
      text
    } satisfies OfficeTextSection];
  });

  if (!sections.length) {
    const generated = await ast.to("text");
    const text = normalizeOfficeText(typeof generated.value === "string" ? generated.value : "");
    if (text) sections.push({ index: 0, kind: "section", title: "正文", text });
  }

  return {
    fileType: ast.type,
    sections,
    pageCount: ast.type === "pptx" || ast.type === "odp"
      ? ast.content.filter((node) => node.type === "slide").length
      : undefined,
    textCharacterCount: sections.reduce((sum, section) => sum + section.text.length, 0),
    warnings: warnings.map((warning) => ({
      code: typeof warning.code === "string" ? warning.code : undefined,
      message: warning.message
    }))
  };
}

function collectNodeText(node: OfficeContentNode): string {
  const values = [
    node.text,
    ...(node.children ?? []).map(collectNodeText),
    ...(node.notes ?? []).map(collectNodeText)
  ];
  return values.filter(Boolean).join("\n");
}

function officeSectionKind(type: OfficeContentNode["type"]): OfficeTextSection["kind"] {
  if (type === "slide") return "slide";
  if (type === "sheet") return "sheet";
  if (type === "page") return "page";
  return "section";
}

function officeSectionTitle(node: OfficeContentNode, index: number) {
  if (node.type === "slide") return `幻灯片 ${node.metadata?.slideNumber ?? index + 1}`;
  if (node.type === "sheet") return `工作表 ${node.metadata?.sheetName || index + 1}`;
  if (node.type === "page") return `第 ${node.metadata?.pageNumber ?? index + 1} 页`;
  if (node.type === "heading" && node.text?.trim()) return node.text.trim();
  return `片段 ${index + 1}`;
}

function normalizeOfficeText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
