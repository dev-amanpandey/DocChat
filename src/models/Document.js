import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  originalName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 255,
  },
  publicId: {
    type: String,
    required: true,
    select: false,
  },
  resourceType: {
    type: String,
    required: true,
    enum: ['raw'],
  },
  deliveryType: {
    type: String,
    required: true,
    enum: ['upload', 'authenticated'],
    default: 'upload',
    select: false,
  },
  mimeType: {
    type: String,
    required: true,
    enum: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
      'text/x-markdown',
    ],
  },
  size: {
    type: Number,
    required: true,
    min: 1,
  },
  status: {
    type: String,
    enum: ['uploaded', 'processing', 'ready', 'failed', 'deleting'],
    default: 'uploaded',
    index: true,
  },
  processingAttempts: { type: Number, default: 0, min: 0 },
  processingStartedAt: { type: Date },
  processingError: {
    _id: false,
    code: { type: String, enum: ['EMPTY_PDF', 'NO_EXTRACTABLE_TEXT', 'PDF_EXTRACTION_FAILED', 'STORAGE_UNAVAILABLE', 'PROCESSING_FAILED'] },
    message: { type: String, maxlength: 300 },
  },
  pageCount: { type: Number, min: 0 },
  chunkCount: { type: Number, min: 0 },
  processedAt: { type: Date },
  embeddingStatus: {
    type: String,
    enum: ['not_applicable', 'pending', 'processing', 'ready', 'failed'],
    default() { return this.mimeType === 'application/pdf' ? 'pending' : 'not_applicable'; },
    index: true,
  },
  embeddingAttempts: { type: Number, default: 0, min: 0 },
  embeddingStartedAt: { type: Date },
  embeddingModel: { type: String },
  embeddingProvider: { type: String },
  embeddingDimensions: { type: Number },
  embeddingError: {
    _id: false,
    code: { type: String, enum: ['CONFIG_MISSING', 'RATE_LIMITED', 'PROVIDER_ERROR', 'INPUT_TOO_LONG', 'EMPTY_CHUNK', 'NO_CHUNKS', 'EMBEDDING_FAILED'] },
    message: { type: String, maxlength: 300 },
  },
  embeddedAt: { type: Date },
}, { timestamps: true });

documentSchema.index({ owner: 1, createdAt: -1 });

export const Document = mongoose.models.Document ?? mongoose.model('Document', documentSchema);
