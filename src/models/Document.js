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
  storedName: {
    type: String,
    required: true,
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
    enum: ['uploaded', 'processing', 'ready', 'failed'],
    default: 'uploaded',
    index: true,
  },
}, { timestamps: true });

documentSchema.index({ owner: 1, createdAt: -1 });

export const Document = mongoose.models.Document ?? mongoose.model('Document', documentSchema);
