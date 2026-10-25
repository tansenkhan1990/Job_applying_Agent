import PDFDocument from 'pdfkit';
import { Document as DocxDocument, Packer, Paragraph, TextRun } from 'docx';
import { JobModel } from '../src/models/Job.js';
import { normalizeListing } from '../src/services/jobs/normalize.js';
import type { JobListing } from '../src/services/jobs/types.js';
import { DocumentModel } from '../src/models/Document.js';
import { CandidateProfileModel } from '../src/models/CandidateProfile.js';
import { ensureDefaultProfiles, linkProfileDocuments } from '../src/services/profilesService.js';
import { sha256 } from '../src/utils/hash.js';
import { PROFILE_KINDS, type ProfileKind } from '../src/config/defaults.js';

export const CV_TEXT = `Jane Example
Senior Full Stack Engineer
Berlin, Germany | jane@example.com

Professional experience
2021 - present: Senior Full Stack Engineer at Example Commerce GmbH
Built checkout services with TypeScript, React, Node.js, Express, PostgreSQL, MongoDB and Docker.
Designed REST APIs, GraphQL gateways and CI/CD pipelines.
2018 - 2021: Software Engineer at Example Digital GmbH
Worked with JavaScript, TypeScript, React, Node.js, HTML and CSS.

Skills
TypeScript, JavaScript, React, Node.js, Express, GraphQL, REST APIs, PostgreSQL, MongoDB, Docker, CI/CD, HTML, CSS
Languages: English (C2), German (B2)
Education: BSc Computer Science, Example University, 2018`;

export async function makePdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(11).text(text, { width: 480 });
    doc.end();
  });
}

export async function makeEmptyPdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export async function makeDocx(text: string): Promise<Buffer> {
  const document = new DocxDocument({
    sections: [
      {
        properties: {},
        children: [new Paragraph({ children: [new TextRun(text)] })],
      },
    ],
  });
  return Packer.toBuffer(document);
}

export async function seedDocument(input: {
  filename: string;
  profileKind: ProfileKind;
  docType: 'cv' | 'cover_letter';
  text?: string;
}) {
  const text = input.text ?? (input.docType === 'cv' ? CV_TEXT : `Dear Hiring Manager,\n\n${CV_TEXT}\n\nSincerely,\nJane Example`);
  return DocumentModel.create({
    filename: input.filename,
    relativePath: `${input.docType === 'cv' ? 'cvs' : 'cover-letters'}/${input.filename}`,
    extension: '.pdf',
    docType: input.docType,
    profileKind: input.profileKind,
    mappingSource: 'manual',
    mappingReviewed: true,
    sizeBytes: text.length,
    contentHash: sha256(text),
    text,
    textPreview: text.slice(0, 600),
    wordCount: text.split(/\s+/).length,
    pageCount: 1,
    status: 'processed',
    parsedWith: 'test-fixture',
  });
}

export async function seedJob(listing: JobListing, overrides: Record<string, unknown> = {}) {
  const normalized = normalizeListing(listing);
  const job = new JobModel({
    ...normalized,
    status: 'active',
    discoveredAt: new Date(),
    lastVerifiedAt: new Date(),
    ...overrides,
  });
  await job.save();
  return job;
}

export async function seedApprovedProfiles(): Promise<void> {
  await ensureDefaultProfiles();
  for (const kind of PROFILE_KINDS) {
    await seedDocument({ filename: `${kind}-cv.pdf`, profileKind: kind, docType: 'cv' });
    await seedDocument({
      filename: `${kind}-cover-letter.pdf`,
      profileKind: kind,
      docType: 'cover_letter',
    });
  }
  await linkProfileDocuments();
  await CandidateProfileModel.updateMany({}, { $set: { status: 'approved', name: 'Jane Example' } });
}

export async function seedPendingProfile(kind: ProfileKind = 'full_stack') {
  await ensureDefaultProfiles();
  const cv = await seedDocument({ filename: `${kind}-cv.pdf`, profileKind: kind, docType: 'cv' });
  const profile = await CandidateProfileModel.findOneAndUpdate(
    { kind },
    { $set: { cvDocument: cv._id, status: 'draft' } },
    { new: true },
  );
  return { profile: profile!, cv };
}
