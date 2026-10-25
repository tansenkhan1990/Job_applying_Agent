# Documents folder

Place your real CVs and cover letters here. The folder is mounted **read-only** into the
backend container; the application never modifies, moves or deletes these files.

Recommended layout:

```text
documents/
├── cvs/
│   ├── full-stack-cv.pdf
│   ├── ai-engineer-cv.pdf
│   └── devops-cloud-cv.pdf
└── cover-letters/
    ├── full-stack-cover-letter.pdf
    ├── ai-engineer-cover-letter.pdf
    └── devops-cloud-cover-letter.pdf
```

- Supported formats: text-based PDF and DOCX.
- Scanned PDFs are detected and marked `needs_ocr`; run OCR first.
- Filenames are hints only. If a filename differs, assign the document to the correct
  career profile on the **Documents** page and press **Rescan**.
- After replacing a file, press **Rescan**: the content hash changes, the document is
  re-parsed, and applications prepared against the old version are blocked until
  re-approved.
- Documents are git-ignored. Do not commit real CVs or personal data.
