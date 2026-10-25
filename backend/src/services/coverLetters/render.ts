import PDFDocument from 'pdfkit';
import { Document as DocxDocument, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

export interface LetterContent {
  subjectLine: string;
  letterText: string;
  candidateName?: string;
}

export async function renderLetterPdf(content: LetterContent): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(13).text(content.subjectLine || 'Cover Letter');
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(11).text(content.letterText, {
      align: 'left',
      lineGap: 3,
    });
    if (content.candidateName) {
      doc.moveDown(2);
      doc.font('Helvetica-Oblique').fontSize(9).text(content.candidateName);
    }
    doc.end();
  });
}

export async function renderLetterDocx(content: LetterContent): Promise<Buffer> {
  const paragraphs = content.letterText.split(/\n{2,}/).map(
    (block) =>
      new Paragraph({
        children: [new TextRun({ text: block.replace(/\n/g, ' '), size: 22 })],
        spacing: { after: 200 },
      }),
  );

  const document = new DocxDocument({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            text: content.subjectLine || 'Cover Letter',
            heading: HeadingLevel.HEADING_2,
            spacing: { after: 300 },
          }),
          ...paragraphs,
          ...(content.candidateName
            ? [
                new Paragraph({
                  children: [new TextRun({ text: content.candidateName, italics: true, size: 20 })],
                  spacing: { before: 400 },
                }),
              ]
            : []),
        ],
      },
    ],
  });

  return Packer.toBuffer(document);
}
