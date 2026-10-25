import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { DocumentModel } from '../src/models/Document.js';
import { CandidateProfileModel } from '../src/models/CandidateProfile.js';
import { env } from '../src/config/env.js';
import { parseDocument } from '../src/services/documents/parser.js';
import { scanDocumentsFolder } from '../src/services/documents/scanner.js';
import { rescanDocuments, setDocumentMapping, inferMapping } from '../src/services/documents/ingestion.js';
import { ensureDefaultProfiles } from '../src/services/profilesService.js';
import { makeDocx, makeEmptyPdf, makePdf, CV_TEXT } from './helpers.js';

let tempRoot: string;
const originalDocumentsPath = env.documentsPath;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'job-agent-scan-'));
  env.documentsPath = tempRoot;
});

describe('document parsing', () => {
  it('extracts text and page count from a PDF', async () => {
    const buffer = await makePdf(CV_TEXT);
    const parsed = await parseDocument(buffer, '.pdf');
    expect(parsed.text).toContain('Senior Full Stack Engineer');
    expect(parsed.pageCount).toBe(1);
    expect(parsed.needsOcr).toBe(false);
    expect(parsed.parsedWith).toBe('pdf-parse');
  });

  it('extracts text from a DOCX file', async () => {
    const buffer = await makeDocx('Jane Example - TypeScript, React and Node.js experience.');
    const parsed = await parseDocument(buffer, '.docx');
    expect(parsed.text).toContain('TypeScript, React and Node.js');
    expect(parsed.needsOcr).toBe(false);
    expect(parsed.parsedWith).toContain('mammoth');
  });

  it('flags a PDF with no extractable text as requiring OCR', async () => {
    const buffer = await makeEmptyPdf();
    const parsed = await parseDocument(buffer, '.pdf');
    expect(parsed.needsOcr).toBe(true);
    expect(parsed.pageCount).toBeGreaterThan(0);
  });

  it('rejects unsupported extensions and corrupt files', async () => {
    await expect(parseDocument(Buffer.from('text'), '.txt')).rejects.toThrow(/Unsupported/);
    await expect(parseDocument(Buffer.from('not a pdf'), '.pdf')).rejects.toThrow();
  });
});

describe('document ingestion', () => {
  it('scans the configured folder read-only, maps filenames and links profiles', async () => {
    await ensureDefaultProfiles();
    await fs.mkdir(path.join(tempRoot, 'cvs'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'cover-letters'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'cvs', 'full-stack-cv.pdf'), await makePdf(CV_TEXT));
    await fs.writeFile(
      path.join(tempRoot, 'cvs', 'ai-engineer-cv.pdf'),
      await makePdf('AI Engineer. Python, FastAPI, RAG, LangGraph and LLM APIs.'),
    );
    await fs.writeFile(
      path.join(tempRoot, 'cover-letters', 'full-stack-cover-letter.docx'),
      await makeDocx('Dear Hiring Manager, I build TypeScript and React systems.'),
    );

    const scanned = await scanDocumentsFolder(tempRoot);
    expect(scanned.rootExists).toBe(true);
    expect(scanned.files).toHaveLength(3);

    const summary = await rescanDocuments();
    expect(summary.added).toBe(3);
    expect(summary.failed).toBe(0);

    const docs = await DocumentModel.find({});
    const fullStackCv = docs.find((doc) => doc.filename === 'full-stack-cv.pdf');
    expect(fullStackCv?.docType).toBe('cv');
    expect(fullStackCv?.profileKind).toBe('full_stack');
    expect(fullStackCv?.status).toBe('processed');
    expect(fullStackCv?.mappingSource).toBe('auto');

    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
    expect(String(profile?.cvDocument)).toBe(String(fullStackCv?._id));
    expect(String(profile?.coverLetterDocument)).toBe(
      String(docs.find((doc) => doc.docType === 'cover_letter')?._id),
    );

    // A second scan is idempotent.
    const second = await rescanDocuments();
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(3);
  });

  it('detects changed and removed documents without deleting records', async () => {
    await ensureDefaultProfiles();
    await fs.mkdir(path.join(tempRoot, 'cvs'), { recursive: true });
    const cvPath = path.join(tempRoot, 'cvs', 'devops-cloud-cv.pdf');
    await fs.writeFile(cvPath, await makePdf('DevOps CV with Docker and Kubernetes.'));
    await rescanDocuments();
    const first = await DocumentModel.findOne({ filename: 'devops-cloud-cv.pdf' });
    expect(first?.contentHash).toBeTruthy();

    await fs.writeFile(cvPath, await makePdf('DevOps CV with Docker, Kubernetes, AWS and Terraform.'));
    const changed = await rescanDocuments();
    expect(changed.updated).toBe(1);
    const second = await DocumentModel.findOne({ filename: 'devops-cloud-cv.pdf' });
    expect(second?.contentHash).not.toBe(first?.contentHash);
    expect(second?.text).toBeUndefined();

    await fs.unlink(cvPath);
    const removed = await rescanDocuments();
    expect(removed.missing).toBe(1);
    const missing = await DocumentModel.findOne({ filename: 'devops-cloud-cv.pdf' });
    expect(missing?.missing).toBe(true);
    expect(missing?.status).toBe('missing');
  });

  it('supports manual mapping overrides and ignores manual mapping on rescan', async () => {
    await ensureDefaultProfiles();
    await fs.mkdir(path.join(tempRoot, 'cvs'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'cvs', 'full-stack-cv.pdf'), await makePdf(CV_TEXT));
    await rescanDocuments();
    const doc = await DocumentModel.findOne({ filename: 'full-stack-cv.pdf' });

    const mapped = await setDocumentMapping(String(doc?._id), {
      docType: 'cv',
      profileKind: 'ai_engineer',
    });
    expect(mapped?.profileKind).toBe('ai_engineer');
    expect(mapped?.mappingSource).toBe('manual');

    await rescanDocuments();
    const after = await DocumentModel.findById(doc?._id);
    expect(after?.profileKind).toBe('ai_engineer');
    expect(after?.mappingSource).toBe('manual');

    const profile = await CandidateProfileModel.findOne({ kind: 'ai_engineer' });
    expect(String(profile?.cvDocument)).toBe(String(doc?._id));
  });

  it('infers mappings from common filenames', () => {
    expect(inferMapping('full-stack-cv.pdf', 'cvs/full-stack-cv.pdf')).toEqual({
      docType: 'cv',
      profileKind: 'full_stack',
    });
    expect(inferMapping('ai-engineer-cover-letter.pdf', 'cover-letters/ai-engineer-cover-letter.pdf')).toEqual({
      docType: 'cover_letter',
      profileKind: 'ai_engineer',
    });
    expect(inferMapping('devops-cloud-cv.docx', 'cvs/devops-cloud-cv.docx').profileKind).toBe('devops_cloud');
    expect(inferMapping('random.pdf', 'random.pdf').docType).toBe('unknown');
  });

  it('reports a missing documents folder without throwing', async () => {
    env.documentsPath = path.join(tempRoot, 'does-not-exist');
    const summary = await rescanDocuments();
    expect(summary.rootExists).toBe(false);
    expect(summary.warnings.length).toBeGreaterThan(0);
    env.documentsPath = originalDocumentsPath;
  });
});
