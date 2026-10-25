import path from 'node:path';
import mammoth from 'mammoth';
import { normalizeWhitespace, wordCount } from '../../utils/text.js';

export interface ParsedDocument {
  text: string;
  textPreview: string;
  pageCount: number;
  wordCount: number;
  needsOcr: boolean;
  parsedWith: string;
}

export class DocumentParseError extends Error {
  code: string;

  constructor(message: string, code = 'PARSE_FAILED') {
    super(message);
    this.name = 'DocumentParseError';
    this.code = code;
  }
}

async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const text = normalizeWhitespace(result.text ?? '');
    const pageCount =
      typeof (result as { total?: number }).total === 'number'
        ? (result as { total: number }).total
        : Array.isArray((result as { pages?: unknown[] }).pages)
          ? (result as { pages: unknown[] }).pages.length
          : 0;
    const visibleChars = text.replace(/\s+/g, '').length;
    // A PDF with pages but almost no extractable text is likely a scan.
    const needsOcr = pageCount > 0 && visibleChars < 40;
    return {
      text,
      textPreview: text.slice(0, 600),
      pageCount,
      wordCount: wordCount(text),
      needsOcr,
      parsedWith: 'pdf-parse',
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function parseDocx(buffer: Buffer): Promise<ParsedDocument> {
  const result = await mammoth.extractRawText({ buffer });
  const text = normalizeWhitespace(result.value ?? '');
  const warnings = (result.messages ?? []).map((message) => message.message).slice(0, 5);
  return {
    text,
    textPreview: text.slice(0, 600),
    pageCount: 0,
    wordCount: wordCount(text),
    needsOcr: text.replace(/\s+/g, '').length < 20,
    parsedWith: warnings.length > 0 ? `mammoth (${warnings.length} warning(s))` : 'mammoth',
  };
}

export async function parseDocument(buffer: Buffer, extension: string): Promise<ParsedDocument> {
  const ext = path.extname(`file${extension.toLowerCase()}`) || extension.toLowerCase();
  try {
    if (ext === '.pdf') return await parsePdf(buffer);
    if (ext === '.docx') return await parseDocx(buffer);
    throw new DocumentParseError(`Unsupported document type: ${extension}`, 'UNSUPPORTED_TYPE');
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    const message = error instanceof Error ? error.message : 'Unknown parsing error';
    throw new DocumentParseError(
      message.slice(0, 300) || 'Document could not be parsed',
      ext === '.pdf' ? 'PDF_PARSE_FAILED' : 'DOCX_PARSE_FAILED',
    );
  }
}
