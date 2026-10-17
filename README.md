# DocChat API

DocChat is a document question-answering application. The backend includes environment validation, MongoDB connection setup, authentication, secure document upload and metadata APIs, a health endpoint, and centralized errors.

## Requirements

- Node.js 20 or newer
- MongoDB Atlas cluster and a database user

## Setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Replace the placeholder values in `.env` with your MongoDB Atlas connection string and the allowed frontend origin. Add your machine's IP address to the Atlas network access list and ensure the database user has the needed database permissions.
4. Start in development mode with `npm run dev`.

The server connects to MongoDB before it starts listening. The default port is `3000` and the health endpoint is `GET http://localhost:3000/api/v1/health`.

## Commands

- `npm run dev` — restart the server when source files change
- `npm start` — start the server
- `npm test` — run the test suite
- `npm run test:watch` — run Vitest in watch mode

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | `development`, `test`, or `production` |
| `PORT` | No | `3000` | HTTP listening port |
| `MONGODB_URI` | Yes | — | MongoDB connection URI |
| `CLIENT_ORIGIN` | No | `http://localhost:5173` | Single allowed browser origin for credentialed CORS |

Never commit `.env` or put production credentials in source control. `.env.example` contains placeholders only.

## Authentication configuration

Set `JWT_SECRET` in `.env` to a random secret of at least 32 characters. `JWT_EXPIRES_IN` controls token lifetime and defaults to `1h`. Do not reuse the example secret in a deployed environment.

Authentication endpoints:

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me` (requires `Authorization: Bearer <token>`)

## Document uploads

Supported upload formats are PDF (`.pdf`), Word DOCX (`.docx`), plain text (`.txt`), and Markdown (`.md`). The default maximum size is 20 MB; configure it with `MAX_UPLOAD_SIZE_MB`. Local development stores uploaded files under `UPLOAD_DIR` (default `./uploads`), which is ignored by Git and must not be exposed as a static directory.

Document endpoints require `Authorization: Bearer <token>` from the login response:

- `POST /api/v1/documents/upload` — multipart form field named `file`
- `GET /api/v1/documents` — list your documents; supports `page` and `limit`
- `GET /api/v1/documents/:id` — read your document metadata
- `DELETE /api/v1/documents/:id` — delete your document and its local file

Postman upload: select **POST**, enter `http://localhost:3000/api/v1/documents/upload`, add an `Authorization` header with `Bearer <token>`, then select **Body → form-data**, add a key named `file`, change its type to **File**, and choose a supported document. Local disk storage is for development on a single server; it is not shared across instances and needs a durable, private storage service for production or multi-instance deployments. The API does not provide file download endpoints.
