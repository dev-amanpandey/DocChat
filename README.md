# DocChat API

DocChat is a document question-answering application. The backend includes environment validation, MongoDB connection setup, authentication, secure document upload and metadata APIs, a health endpoint, and centralized errors.

## Requirements

- Node.js 20 or newer
- MongoDB Atlas cluster and a database user
- Cloudinary account with API credentials

## Setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Replace the placeholder values in `.env` with your MongoDB Atlas connection string, allowed frontend origin, and Cloudinary cloud name, API key, and API secret. Add your machine's IP address to the Atlas network access list and ensure the database user has the needed database permissions.
4. Set `GEMINI_API_KEY` to a key created in Google AI Studio. Keep this key in server environment variables on Vercel/Render; never put it in frontend code. Optionally set `GEMINI_EMBEDDING_DIMENSIONS` to an integer from 128 through 3072 (768 is the default; Google recommends 768, 1536, or 3072) and `GEMINI_GENERATION_MODEL` (defaults to `gemini-3.6-flash`).
5. Start in development mode with `npm run dev`.

The server connects to MongoDB before it starts listening. The default port is `3000` and the health endpoint is `GET http://localhost:3000/api/v1/health`.

## Commands

- `npm run dev` — restart the server when source files change
- `npm start` — start the server
- `npm test` — run the test suite
- `npm run test:watch` — run Vitest in watch mode

## Frontend

The React/Vite frontend lives in `frontend/` and uses the backend API. Set `VITE_API_BASE_URL` to the API base URL (defaults to `http://localhost:3000/api/v1`); this value is public configuration and must not contain secrets. Start the backend with `npm run dev`, then start the frontend in another terminal with `npm run dev:frontend` and open the Vite URL shown in the terminal (normally `http://localhost:5173`). For a production bundle, run `npm run build:frontend`; the output is written to `dist/frontend`.

Sign in using an existing account, or register from the sign-in screen. Uploaded documents appear in the sidebar and their processing/indexing status updates automatically. Questions can be limited to one selected, ready document or search across all ready documents.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | `development`, `test`, or `production` |
| `PORT` | No | `3000` | HTTP listening port |
| `MONGODB_URI` | Yes | — | MongoDB connection URI |
| `CLIENT_ORIGIN` | No | `http://localhost:5173` | Single allowed browser origin for credentialed CORS |
| `CLOUDINARY_CLOUD_NAME` | Yes | — | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Yes | — | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Yes | — | Cloudinary API secret; keep private |
| `MAX_UPLOAD_SIZE_MB` | No | `20` | Maximum upload size in megabytes |
| `GEMINI_API_KEY` | Required for embedding and semantic search | — | Google Gemini API key; keep private |
| `GEMINI_EMBEDDING_DIMENSIONS` | No | `768` | Output size from 128 through 3072; changing it makes saved vectors incompatible and requires reprocessing |
| `GEMINI_GENERATION_MODEL` | No | `gemini-3.6-flash` | Gemini text generation model used by document question answering |

Never commit `.env` or put production credentials in source control. `.env.example` contains placeholders only.

## Authentication configuration

Set `JWT_SECRET` in `.env` to a random secret of at least 32 characters. `JWT_EXPIRES_IN` controls token lifetime and defaults to `1h`. Do not reuse the example secret in a deployed environment.

Authentication endpoints:

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me` (requires `Authorization: Bearer <token>`)

## Document uploads

Supported upload formats are PDF (`.pdf`), Word DOCX (`.docx`), plain text (`.txt`), and Markdown (`.md`). The default maximum size is 20 MB; configure it with `MAX_UPLOAD_SIZE_MB`. `express-fileupload` writes incoming files to temporary paths, which the backend uploads directly to Cloudinary as `raw` assets with generated public IDs and removes after the upload attempt. MongoDB stores metadata and the Cloudinary public ID, never the document bytes. The API does not return Cloudinary URLs. This API currently has no document download endpoint, so assets are not exposed through DocChat.

Document endpoints require `Authorization: Bearer <token>` from the login response:

- `POST /api/v1/documents/upload` — multipart form field named `file`
- `GET /api/v1/documents` — list your documents; supports `page` and `limit`
- `GET /api/v1/documents/:id` — read your document metadata
- `DELETE /api/v1/documents/:id` — delete your document and its Cloudinary asset

Postman verification:

1. Register at `POST http://localhost:3000/api/v1/auth/register` or log in at `POST http://localhost:3000/api/v1/auth/login`; copy the returned token.
2. Upload with `POST http://localhost:3000/api/v1/documents/upload`. Set `Authorization: Bearer <token>`. Under **Body → form-data**, add `file` as type **File** and choose a PDF, DOCX, TXT, or MD file. Expect `201` and metadata.
3. List with `GET http://localhost:3000/api/v1/documents` and the same Authorization header.
4. Retrieve metadata with `GET http://localhost:3000/api/v1/documents/<id>` using the `id` from the upload response.
5. Delete with `DELETE http://localhost:3000/api/v1/documents/<id>`. Expect `200` and `{ "message": "Document deleted" }`.

The API does not provide file download endpoints. Failed upload persistence triggers best-effort Cloudinary deletion; a cleanup failure is logged without credentials and the request still returns an error. During deletion, Cloudinary cleanup must succeed before MongoDB removal, so a cleanup error leaves the record available to retry. A MongoDB failure after Cloudinary deletion can leave a metadata record pointing to a missing asset and is reported as an error.

## Gemini embeddings and semantic search

The API uses Google's `gemini-embedding-001` with `RETRIEVAL_DOCUMENT` for saved chunks and `RETRIEVAL_QUERY` for searches. Old OpenAI vectors are considered incompatible by provider/model/dimension metadata. They are regenerated directly from the saved MongoDB chunks; PDFs are not downloaded or re-extracted. Existing ready documents with stale embeddings can be queued using `POST /api/v1/documents/<id>/embeddings/reprocess` with the document owner's bearer token. It returns `202`; poll `GET /api/v1/documents/<id>` until `embeddingStatus` is `ready`. Failed jobs can be safely retried through the same endpoint, and successful chunks are retained.

To search in Postman, send `POST /api/v1/documents/search` with `Authorization: Bearer <token>`, `Content-Type: application/json`, and body `{"query":"your question","limit":5}`. Results retain the existing `{ results: [...] }` response shape and are limited to the authenticated owner's ready documents.

Free-tier Gemini API quota varies by model, account, and project and is shown in Google AI Studio. Google states that unpaid-tier prompts and uploaded content may be used to improve its products and may be reviewed by humans; do not use the unpaid tier for sensitive, confidential, or personal documents. Paid-tier data handling differs, but can involve limited abuse-monitoring logs. Check Google's current [Gemini API terms](https://ai.google.dev/gemini-api/terms) and [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) before a public launch. Free-tier availability and rate limits can change, and Vercel/Render free service limits are separate. Gemini API calls are made only by the backend and the key is never returned to the client.

## Document question answering

`POST /api/v1/ai/ask` answers a question from the authenticated user's indexed document chunks. Send `Authorization: Bearer <token>`, `Content-Type: application/json`, and a body such as `{"question":"What technical skills does the candidate have?","limit":5}`. To restrict retrieval to one of your own documents, include its ID: `{"question":"What skills are listed?","documentId":"<document-id>","limit":5}`. The endpoint returns `{ "answer": "...", "sources": [{ "documentId": "...", "filename": "...", "chunkId": "...", "chunkIndex": 0, "pageNumber": 1, "excerpt": "...", "score": 0.9 }] }`. It returns a clear insufficient-information answer and an empty `sources` list when no matching chunks are available. Only retrieved chunks owned by the authenticated user are sent to Gemini. Document text is treated as untrusted context; instructions found inside it are not intended to be followed.

Postman: log in to obtain a bearer token, then send `POST http://localhost:3000/api/v1/ai/ask` with the JSON body above. For a single-document question, first upload and process a PDF, wait until its `embeddingStatus` is `ready`, and use the returned document `id` as `documentId`. A `429` indicates a Gemini quota/rate limit, and `504` indicates generation timed out; safe provider messages are returned without upstream details.
