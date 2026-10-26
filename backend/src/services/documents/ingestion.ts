import fs from 'node:fs/promises';
import { DocumentModel } from '../../models/Document.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { scanDocumentsFolder, type ScannedFile } from './scanner.js';
import { parseDocument } from './parser.js';
import { linkProfileDocuments } from '../profilesService.js';
import type { ProfileKind } from '../../config/defaults.js';

export interface IngestionSummary {
  rootExists: boolean;
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
  needsOcr: number;
  failed: number;
  autoMapped: number;
  durationMs: number;
  truncated: boolean;
  warnings: string[];
}

export function inferMapping(filename: string, relativePath: string): {
  docType: 'cv' | 'cover_letter' | 'unknown';
  profileKind: ProfileKind | 'unassigned';
} {
  const name = `${relativePath} ${filename}`.toLowerCase();
  let docType: 'cv' | 'cover_letter' | 'unknown' = 'unknown';
  if (/cover[-_ ]?letter|anschreiben|motivation/.test(name)) docType = 'cover_letter';
  else if (/(^|[/_\s-])(cv|resume|lebenslauf)([/_\s.-]|$)/.test(name)) docType = 'cv';

  let profileKind: ProfileKind | 'unassigned' = 'unassigned';
  if (/full[-_ ]?stack|fullstack|web[-_ ]?developer|frontend|backend|javascript/.test(name)) {
    profileKind = 'full_stack';
  } else if (/ai[-_ ]?(engineer|developer)|gen(erative)?[-_ ]?ai|llm|machine[-_ ]?learning|ml[-_ ]?engineer/.test(name)) {
    profileKind = 'ai_engineer';
  } else if (/devops|dev[-_ ]?ops|cloud|sre|platform|infrastructure/.test(name)) {
    profileKind = 'devops_cloud';
  }

  if (docType === 'unknown' && profileKind !== 'unassigned') {
    docType = /cover[-_ ]?letter/.test(name) ? 'cover_letter' : 'unknown';
  }
  return { docType, profileKind };
}

/**
 * Content-based fallback for documents whose filename says nothing useful. This never
 * overrides an explicit manual mapping and only fills gaps left by filename inference.
 */
export function inferDocumentFromText(text: string): {
  docType: 'cv' | 'cover_letter' | 'unknown';
  profileKind: ProfileKind | 'unassigned';
} {
  const lower = text.toLowerCase();
  const count = (patterns: RegExp[]) => patterns.reduce((sum, pattern) => sum + (pattern.test(lower) ? 1 : 0), 0);

  const coverHits = count([
    /\bdear (hiring|sir|madam|professor|prof\.|dr\.|recruit)/,
    /\bi am (writing|applying) (to|for)\b/,
    /\b(yours (sincerely|faithfully)|kind regards|best regards|sincerely)\b/,
    /\b(cover letter|anschreiben|bewerbung|motivation letter)\b/,
    /\bthank you for (considering|your consideration)\b/,
  ]);
  const cvHits = count([
    /\b(curriculum vitae|resume|lebenslauf)\b/,
    /\b(professional|work|employment) experience\b/,
    /\b(education|academic background|ausbildung)\b/,
    /\b(skills|technical skills|kenntnisse)\b/,
    /\b(publications?|projects?)\b/,
  ]);

  let docType: 'cv' | 'cover_letter' | 'unknown' = 'unknown';
  if (coverHits >= 2 && coverHits > cvHits) docType = 'cover_letter';
  else if (cvHits >= 2 && cvHits >= coverHits) docType = 'cv';
  else if (coverHits === 1 && cvHits === 0) docType = 'cover_letter';

  const groups: Array<{ kind: ProfileKind; patterns: RegExp[] }> = [
    {
      kind: 'ai_engineer',
      patterns: [
        /\b(machine learning|deep learning)\b/,
        /\b(llms?|large language models?)\b/,
        /\b(rag|retrieval[- ]augmented generation)\b/,
        /\b(nlp|natural language processing)\b/,
        /\b(pytorch|tensorflow|langchain|langgraph|vector database)\b/,
      ],
    },
    {
      kind: 'devops_cloud',
      patterns: [
        /\b(kubernetes|k8s|terraform|ansible)\b/,
        /\b(aws|azure|google cloud|gcp)\b/,
        /\b(ci\/cd|devops|site reliability|sre)\b/,
        /\b(docker|helm|prometheus|grafana)\b/,
      ],
    },
    {
      kind: 'full_stack',
      patterns: [
        /\b(typescript|javascript)\b/,
        /\b(react|angular|vue|next\.js)\b/,
        /\b(node\.js|express|nestjs)\b/,
        /\b(postgresql|mongodb|graphql|rest apis?)\b/,
      ],
    },
  ];

  const scores = groups.map((group) => ({
    kind: group.kind,
    score: group.patterns.filter((pattern) => pattern.test(lower)).length,
  }));
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const profileKind = best && best.score >= 2 ? best.kind : 'unassigned';

  return { docType, profileKind };
}

async function readFileSafe(file: ScannedFile): Promise<Buffer> {
  const buffer = await fs.readFile(file.absolutePath);
  if (buffer.byteLength > env.maxDocumentSizeBytes) {
    throw new Error(`File exceeds the ${env.MAX_DOCUMENT_SIZE_MB} MB limit`);
  }
  return buffer;
}

export async function rescanDocuments(): Promise<IngestionSummary> {
  const started = Date.now();
  const summary: IngestionSummary = {
    rootExists: false,
    scanned: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    needsOcr: 0,
    failed: 0,
    autoMapped: 0,
    durationMs: 0,
    truncated: false,
    warnings: [],
  };

  const { files, rootExists, truncated } = await scanDocumentsFolder();
  summary.rootExists = rootExists;
  summary.truncated = truncated;
  summary.scanned = files.length;

  if (!rootExists) {
    summary.warnings.push(
      `Documents folder "${env.documentsPath}" is not readable. Mount it read-only into the backend container.`,
    );
    summary.durationMs = Date.now() - started;
    return summary;
  }

  const seenPaths = new Set(files.map((file) => file.relativePath));
  const existingDocs = await DocumentModel.find({}).select('+text');
  const byPath = new Map(existingDocs.map((doc) => [doc.relativePath, doc]));

  for (const file of files) {
    const existing = byPath.get(file.relativePath);
    const inferred = inferMapping(file.filename, file.relativePath);

    if (file.oversized) {
      summary.failed += 1;
      summary.warnings.push(`${file.relativePath} exceeds the size limit and was not parsed.`);
      if (existing) {
        existing.status = 'failed';
        existing.error = `File exceeds ${env.MAX_DOCUMENT_SIZE_MB} MB limit`;
        await existing.save();
      }
      continue;
    }

    if (existing && existing.contentHash === file.contentHash && !existing.missing) {
      existing.lastScannedAt = new Date();
      await existing.save();
      summary.unchanged += 1;
      continue;
    }

    try {
      const buffer = await readFileSafe(file);
      const parsed = await parseDocument(buffer, file.extension);
      const contentInferred = inferDocumentFromText(parsed.text);
      // Filename hints win when present; otherwise the extracted contents decide.
      const mapping = {
        docType: inferred.docType !== 'unknown' ? inferred.docType : contentInferred.docType,
        profileKind:
          inferred.profileKind !== 'unassigned' ? inferred.profileKind : contentInferred.profileKind,
      };

      const patch: Record<string, unknown> = {
        filename: file.filename,
        relativePath: file.relativePath,
        extension: file.extension,
        sizeBytes: file.sizeBytes,
        contentHash: file.contentHash,
        lastModifiedAt: file.lastModifiedAt,
        lastScannedAt: new Date(),
        text: parsed.text,
        textPreview: parsed.textPreview,
        pageCount: parsed.pageCount,
        wordCount: parsed.wordCount,
        parsedWith: parsed.parsedWith,
        missing: false,
        error: parsed.needsOcr ? 'No extractable text found. This looks like a scanned PDF; OCR is required.' : '',
        status: parsed.needsOcr ? 'needs_ocr' : 'processed',
      };

      if (!existing) {
        patch.docType = mapping.docType;
        patch.profileKind = mapping.profileKind;
        patch.mappingSource = mapping.docType !== 'unknown' ? 'auto' : 'none';
        patch.mappingReviewed = false;
        await DocumentModel.create(patch);
        summary.added += 1;
        if (mapping.docType !== 'unknown' && mapping.profileKind !== 'unassigned') summary.autoMapped += 1;
      } else {
        // Preserve manual mappings; re-run inference only for auto mappings.
        if (existing.mappingSource !== 'manual') {
          if (mapping.docType !== 'unknown') {
            patch.docType = mapping.docType;
            patch.mappingSource = 'auto';
          }
          if (existing.profileKind === 'unassigned' && mapping.profileKind !== 'unassigned') {
            patch.profileKind = mapping.profileKind;
            patch.mappingSource = 'auto';
          }
        }
        patch.changedAt = new Date();
        await DocumentModel.updateOne({ _id: existing._id }, { $set: patch });
        summary.updated += 1;
        if (mapping.docType !== 'unknown' && mapping.profileKind !== 'unassigned' && existing.mappingSource !== 'manual') {
          summary.autoMapped += 1;
        }
      }

      if (parsed.needsOcr) {
        summary.needsOcr += 1;
        summary.warnings.push(
          `${file.relativePath}: no extractable text (scanned PDF?). OCR is required before AI matching.`,
        );
      }
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : 'Unknown parse error';
      summary.warnings.push(`${file.relativePath}: ${message}`);
      if (existing) {
        existing.status = 'failed';
        existing.error = message.slice(0, 300);
        existing.lastScannedAt = new Date();
        existing.missing = false;
        await existing.save();
      } else {
        await DocumentModel.create({
          filename: file.filename,
          relativePath: file.relativePath,
          extension: file.extension,
          sizeBytes: file.sizeBytes,
          contentHash: file.contentHash || 'unavailable',
          lastModifiedAt: file.lastModifiedAt,
          lastScannedAt: new Date(),
          status: 'failed',
          error: message.slice(0, 300),
          docType: inferred.docType,
          profileKind: inferred.profileKind,
          mappingSource: inferred.docType !== 'unknown' ? 'auto' : 'none',
        });
      }
    }
  }

  // Documents that disappeared from disk are marked missing, never deleted.
  for (const doc of existingDocs) {
    if (!seenPaths.has(doc.relativePath) && !doc.missing) {
      doc.missing = true;
      doc.status = 'missing';
      doc.error = 'File is no longer present in the documents folder.';
      doc.lastScannedAt = new Date();
      await doc.save();
      summary.missing += 1;
    }
  }

  await linkProfileDocuments();

  summary.durationMs = Date.now() - started;
  logger.info(
    {
      scanned: summary.scanned,
      added: summary.added,
      updated: summary.updated,
      failed: summary.failed,
      needsOcr: summary.needsOcr,
      missing: summary.missing,
      durationMs: summary.durationMs,
    },
    'Document rescan complete',
  );

  return summary;
}

export async function setDocumentMapping(
  id: string,
  mapping: { docType: 'cv' | 'cover_letter' | 'unknown'; profileKind: ProfileKind | 'unassigned'; mappingReviewed?: boolean },
) {
  const doc = await DocumentModel.findById(id);
  if (!doc) return null;

  doc.docType = mapping.docType;
  doc.profileKind = mapping.profileKind;
  doc.mappingSource = 'manual';
  doc.mappingReviewed = mapping.mappingReviewed ?? true;
  await doc.save();
  await linkProfileDocuments();
  return doc;
}
