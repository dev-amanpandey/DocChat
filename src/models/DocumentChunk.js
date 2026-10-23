import mongoose from 'mongoose';

const documentChunkSchema = new mongoose.Schema({
  document: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document',
    required: true,
    index: true,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  chunkIndex: { type: Number, required: true, min: 0 },
  pageNumber: { type: Number, required: true, min: 1 },
  text: { type: String, required: true },
  embedding: { type: [Number], select: false },
  embeddingModel: { type: String, select: false },
  embeddingProvider: { type: String, select: false },
  embeddingDimensions: { type: Number, select: false },
}, { timestamps: true });

documentChunkSchema.index({ document: 1, owner: 1, chunkIndex: 1 }, { unique: true });
documentChunkSchema.index({ owner: 1, embeddingModel: 1, embeddingDimensions: 1 });

export const DocumentChunk = mongoose.models.DocumentChunk
  ?? mongoose.model('DocumentChunk', documentChunkSchema);
