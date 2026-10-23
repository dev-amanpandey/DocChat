import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  document: null,
  chunks: [],
  lastDownload: null,
}));

vi.mock('../src/models/Document.js', () => ({
  Document: {
    findOne(filter) {
      const found = state.document?.id === filter._id && state.document.owner === filter.owner
        ? state.document : null;
      return { select: async () => found };
    },
    async updateOne(filter, update) {
      const document = state.document;
      if (!document || document.id !== filter._id || document.owner !== filter.owner) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (filter.status?.$in && !filter.status.$in.includes(document.status)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      Object.assign(document, update.$set ?? {});
      for (const key of Object.keys(update.$unset ?? {})) delete document[key];
      for (const [key, amount] of Object.entries(update.$inc ?? {})) document[key] = (document[key] ?? 0) + amount;
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
}));

vi.mock('../src/models/DocumentChunk.js', () => ({
  DocumentChunk: {
    async deleteMany(filter) {
      state.chunks = state.chunks.filter((chunk) =>
        chunk.document !== filter.document || chunk.owner !== filter.owner);
      return { deletedCount: 0 };
    },
    async insertMany(chunks) {
      state.chunks.push(...chunks);
      return chunks;
    },
  },
}));

vi.mock('../src/services/documentStorage.js', () => ({
  downloadStoredFile: vi.fn(async (...args) => {
    state.lastDownload = args;
    return Buffer.from('pdf bytes');
  }),
}));
vi.mock('../src/services/documentEmbeddings.js', () => ({ queueDocumentEmbedding: vi.fn() }));

const {
  DocumentProcessingError,
  extractPdfPages,
  processDocument,
  splitPagesIntoChunks,
  splitTextIntoChunks,
} = await import('../src/services/documentProcessing.js');

function buildPdf(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
}

function makePdf(text = 'Hello PDF world') {
  const stream = text
    ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
    : 'BT ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  return buildPdf(objects);
}

function makeZeroPagePdf() {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [] /Count 0 >>',
  ]);
}

beforeEach(() => {
  state.document = {
    id: '64b000000000000000000001',
    owner: '64a000000000000000000001',
    publicId: 'docchat/00000000-0000-4000-8000-000000000001.pdf',
    resourceType: 'raw',
    deliveryType: 'authenticated',
    status: 'uploaded',
    mimeType: 'application/pdf',
  };
  state.chunks = [];
  state.lastDownload = null;
});

describe('PDF extraction and chunking', () => {
  it('extracts page text from a PDF', async () => {
    const result = await extractPdfPages(makePdf());
    expect(result.pageCount).toBe(1);
    expect(result.pages).toEqual([{ pageNumber: 1, text: 'Hello PDF world' }]);
  });

  it('splits text with the configured overlap', () => {
    const chunks = splitTextIntoChunks('abcdefghijklmnopqrstuvwxyz', { chunkSize: 10, overlap: 3 });
    expect(chunks).toEqual(['abcdefghij', 'hijklmnopq', 'opqrstuvwx', 'vwxyz']);
    expect(chunks[0].slice(-3)).toBe(chunks[1].slice(0, 3));
  });

  it('retains page numbers and a global chunk index', () => {
    expect(splitPagesIntoChunks([
      { pageNumber: 1, text: 'first page' },
      { pageNumber: 2, text: 'second page' },
    ])).toEqual([
      { chunkIndex: 0, pageNumber: 1, text: 'first page' },
      { chunkIndex: 1, pageNumber: 2, text: 'second page' },
    ]);
    expect(splitTextIntoChunks('  \n ')).toEqual([]);
  });

  it('classifies a valid PDF with no selectable text explicitly', async () => {
    await expect(extractPdfPages(makePdf(''))).rejects.toMatchObject({ code: 'NO_EXTRACTABLE_TEXT' });
  });

  it('classifies a PDF with no pages as empty', async () => {
    await expect(extractPdfPages(makeZeroPagePdf())).rejects.toMatchObject({ code: 'EMPTY_PDF' });
  });

  it('reports malformed PDFs as extraction failures', async () => {
    await expect(extractPdfPages(Buffer.from('%PDF malformed')))
      .rejects.toMatchObject({ code: 'PDF_EXTRACTION_FAILED' });
  });

  it('stores owner-scoped chunks and processing metadata', async () => {
    const succeeded = await processDocument(state.document.id, state.document.owner, {
      download: async (...args) => { state.lastDownload = args; return Buffer.from('pdf'); },
      extract: async () => ({ pageCount: 2, pages: [
        { pageNumber: 1, text: 'alpha text' },
        { pageNumber: 2, text: 'beta text' },
      ] }),
    });
    expect(succeeded).toBe(true);
    expect(state.lastDownload).toEqual([state.document.publicId, 'raw', 'authenticated']);
    expect(state.document).toMatchObject({ status: 'ready', pageCount: 2, chunkCount: 2, processingAttempts: 1 });
    expect(state.chunks.map(({ owner, pageNumber, chunkIndex }) => ({ owner, pageNumber, chunkIndex }))).toEqual([
      { owner: state.document.owner, pageNumber: 1, chunkIndex: 0 },
      { owner: state.document.owner, pageNumber: 2, chunkIndex: 1 },
    ]);
  });

  it('does not process a document for a different owner', async () => {
    const download = vi.fn();
    const succeeded = await processDocument(state.document.id, '64a000000000000000000099', { download });
    expect(succeeded).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(state.chunks).toHaveLength(0);
  });

  it('marks storage and extraction failures failed and leaves no partial chunks', async () => {
    const storageSucceeded = await processDocument(state.document.id, state.document.owner, {
      download: async () => { throw new Error('storage unavailable'); },
    });
    expect(storageSucceeded).toBe(false);
    expect(state.document).toMatchObject({ status: 'failed', processingError: { code: 'STORAGE_UNAVAILABLE' } });
    expect(state.chunks).toHaveLength(0);

    state.document.status = 'failed';
    const extractionSucceeded = await processDocument(state.document.id, state.document.owner, {
      download: async () => Buffer.from('pdf'),
      extract: async () => { throw new DocumentProcessingError('EMPTY_PDF', 'PDF contains no pages'); },
    });
    expect(extractionSucceeded).toBe(false);
    expect(state.document.processingError.code).toBe('EMPTY_PDF');
    expect(state.chunks).toHaveLength(0);
  });
});
