import { Router } from 'express';
import { z } from 'zod';
import { DocumentModel } from '../models/Document.js';
import { objectIdSchema, documentMappingSchema } from '../schemas.js';
import { rescanDocuments, setDocumentMapping } from '../services/documents/ingestion.js';
import { env } from '../config/env.js';
import { notFound } from '../utils/errors.js';
import { serialize } from '../utils/serialize.js';
import { scanDocumentsFolder } from '../services/documents/scanner.js';

export const documentsRouter = Router();

documentsRouter.get('/', async (_req, res) => {
  const docs = await DocumentModel.find({}).sort({ relativePath: 1 });
  const folder = await scanDocumentsFolder();
  res.json({
    documents: docs.map((doc) => serialize(doc)),
    folder: {
      configuredPath: env.documentsPath,
      readable: folder.rootExists,
      filesFound: folder.files.length,
      maxSizeMb: env.MAX_DOCUMENT_SIZE_MB,
    },
    counts: {
      total: docs.length,
      processed: docs.filter((doc) => doc.status === 'processed').length,
      needsOcr: docs.filter((doc) => doc.status === 'needs_ocr').length,
      failed: docs.filter((doc) => doc.status === 'failed').length,
      missing: docs.filter((doc) => doc.missing).length,
      unmapped: docs.filter((doc) => doc.docType === 'unknown' || doc.profileKind === 'unassigned').length,
    },
  });
});

documentsRouter.post('/rescan', async (_req, res) => {
  const summary = await rescanDocuments();
  res.json(summary);
});

documentsRouter.get('/:id/text', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const doc = await DocumentModel.findById(id).select('+text');
  if (!doc) throw notFound('Document');
  res.json({
    id: String(doc._id),
    filename: doc.filename,
    status: doc.status,
    text: doc.text ?? '',
    wordCount: doc.wordCount,
    pageCount: doc.pageCount,
    truncated: (doc.text ?? '').length >= 200_000,
  });
});

documentsRouter.patch('/:id/mapping', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const mapping = documentMappingSchema.parse(req.body);
  const doc = await setDocumentMapping(id, mapping);
  if (!doc) throw notFound('Document');
  res.json(serialize(doc));
});
