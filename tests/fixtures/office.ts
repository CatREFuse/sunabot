import { writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

export type MinimalOfficeFormat = "docx" | "xlsx" | "odt" | "odp" | "ods";

export async function writeMinimalOfficeFixture(
  directory: string,
  format: MinimalOfficeFormat,
  text: string
) {
  const zip = new JSZip();
  if (format === "docx") addDocx(zip, text);
  else if (format === "xlsx") addXlsx(zip, text);
  else addOpenDocument(zip, format, text);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const filePath = path.join(directory, `minimal.${format}`);
  await writeFile(filePath, bytes, { mode: 0o600 });
  return { bytes, filePath };
}

export async function writePptxParserBoundaryFixture(directory: string) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`
  ));
  zip.file("ppt/presentation.xml", xml(
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`
  ));
  zip.file("ppt/slides/slide1.xml", pptxSlide(""));
  zip.file("ppt/slides/slide2.xml", pptxSlide(
    `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill><p:spPr/></p:pic>`
  ));
  zip.file("ppt/slides/_rels/slide2.xml.rels", xml(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`
  ));
  zip.file("ppt/media/image1.png", Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  ));
  zip.file("ppt/slides/slide3.xml", pptxSlide(
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>唯一含正文的幻灯片</a:t></a:r></a:p></p:txBody></p:sp>`
  ));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const filePath = path.join(directory, "parser-boundary.pptx");
  await writeFile(filePath, bytes, { mode: 0o600 });
  return { bytes, filePath, sourcePageCount: 3 };
}

function addDocx(zip: JSZip, text: string) {
  zip.file("[Content_Types].xml", xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
  ));
  zip.file("word/document.xml", xml(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:body></w:document>`
  ));
}

function addXlsx(zip: JSZip, text: string) {
  zip.file("[Content_Types].xml", xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
  ));
  zip.file("xl/workbook.xml", xml(
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>`
  ));
  zip.file("xl/_rels/workbook.xml.rels", xml(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
  ));
  zip.file("xl/sharedStrings.xml", xml(
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>${escapeXml(text)}</t></si></sst>`
  ));
  zip.file("xl/worksheets/sheet1.xml", xml(
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`
  ));
}

function addOpenDocument(zip: JSZip, format: "odt" | "odp" | "ods", text: string) {
  const mediaType = `application/vnd.oasis.opendocument.${format === "odt" ? "text" : format === "odp" ? "presentation" : "spreadsheet"}`;
  zip.file("mimetype", mediaType, { compression: "STORE" });
  zip.file("META-INF/manifest.xml", xml(
    `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mediaType}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`
  ));
  zip.file("content.xml", xml(openDocumentBody(format, text)));
}

function openDocumentBody(format: "odt" | "odp" | "ods", text: string) {
  const escaped = escapeXml(text);
  const namespaces = [
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
    'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"'
  ].join(" ");
  const body = format === "odt"
    ? `<office:text><text:p>${escaped}</text:p></office:text>`
    : format === "ods"
      ? `<office:spreadsheet><table:table table:name="数据"><table:table-row><table:table-cell office:value-type="string"><text:p>${escaped}</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>`
      : `<office:presentation><draw:page draw:name="page1"><draw:frame presentation:class="title"><draw:text-box><text:p>${escaped}</text:p></draw:text-box></draw:frame></draw:page></office:presentation>`;
  return `<office:document-content ${namespaces} office:version="1.2"><office:body>${body}</office:body></office:document-content>`;
}

function xml(body: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>${body}`;
}

function pptxSlide(content: string) {
  return xml(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${content}</p:spTree></p:cSld></p:sld>`);
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
  })[character]!);
}
