# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

This project has a Node.js API server (port 3001) and a static file server (port 8080). Both must be running for the app to work.

### Quick Start (recommended)

```bash
npm run dev
```

This starts the API server, the static file server, and opens the browser in one command (uses `concurrently`).

### Manual Start

```bash
# Terminal 1 — API server (port 3001)
npm start

# Terminal 2 — Static file server (port 8080)
npm run static

# Then open http://localhost:8080
```

### Prerequisites

- Node.js 18+ with `npm install` run to install dependencies
- `claude` CLI installed and authenticated (`claude --version` should work)
  - The server spawns `claude -p` for each persona turn — it must be in your PATH
  - Authenticate with `claude auth` before running persona turns

### npm Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the API server on port 3001 |
| `npm test` | Run all Vitest tests (no real claude calls) |
| `npm run dev` | Start API server + static server + open browser |
| `npm run server` | Alias for `npm start` |
| `npm run static` | Start Python static file server on port 8080 |

## Architecture

**Two-page frontend (no framework/bundler) + Node.js API backend.** All frontend JS is vanilla ES modules loaded directly by the browser.

### Frontend Files

| File | Purpose |
|------|---------|
| `index.html` + `home.js` | Chat directory — lists, creates, deletes chats |
| `chat.html` + `app.js` | Session workspace — messages, notes, JSON preview |
| `theme.js` | Light/dark mode toggle (shared) |
| `styles.css` | All styles |

### Backend Files

| File | Purpose |
|------|---------|
| `server.js` | Express app — API routes, CORS, SSE streaming |
| `lib/prompt-builder.js` | Assembles the full prompt string for each persona's turn |
| `lib/response-parser.js` | Parses and validates `claude -p --output-format json` output |
| `lib/persistence.js` | Reads/writes monologue files and session JSON to disk |
| `lib/turn-orchestrator.js` | Orchestrates a full round: randomizes order, spawns `claude -p` per persona, emits events |
| `personas/<id>/system.md` | System prompt files for each AI persona (blake, yui, grant, julia) |

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check — returns `{ status: "ok" }` |
| `POST` | `/api/turn` | Run a full persona turn round; streams results via SSE |
| `GET` | `/api/monologue/:sessionId/:personaId` | Fetch a persona's monologue entries; returns `[]` if none |

#### POST /api/turn

Request body: `{ sessionId, messages, notes?, attachedFiles?, personas?, model? }`

Response: SSE stream (`Content-Type: text/event-stream`) with events:
- `thinking` — `{ personaId, personaName }` when a persona starts
- `message` — `{ personaId, message, action }` when a persona finishes
- `notes` — `{ content }` when session notes are updated by a persona
- `done` — `{}` when the round completes
- `error` — `{ personaId, error }` on persona failure

Returns `409 Conflict` if a turn is already in progress for the same `sessionId`.

#### GET /api/monologue/:sessionId/:personaId

Returns a JSON array of monologue entries:
```json
[{ "timestamp": "ISO string", "text": "string", "type": "think|research" }]
```

Returns `[]` if no monologue file exists yet. Returns `500` on unexpected filesystem errors.

### Data Flow

`session-chat.json` is the canonical data shape. On load, `app.js` merges two sources:

1. **File-backed chats** — seeded JSON in `chats/<chat-id>/session-chat.json`, registered in `chats/index.json`
2. **localStorage overlay** — stored under key `open-think-tank-chat-<id>`; takes priority over file data

localStorage wins on conflict. After each persona turn, the server also writes `session-chat.json` and monologue files to disk in `chats/<id>/`.

### Session JSON Schema (`formatVersion: "1.0"`)

```json
{
  "formatVersion": "1.0",
  "session": { "id", "title", "startedAt", "updatedAt", "topic" },
  "personas": [{ "id", "name", "displayName", "role", "avatar", "avatarPosition", "avatarScale", "prioritizes" }],
  "notes": { "content" },
  "messages": [{ "id", "speakerId", "timestamp", "text" }]
}
```

- `role` is `"ai-persona"` or `"human"` (determines message alignment)
- `speakerId` must match a `persona.id`
- `avatarPosition` is a CSS `object-position` string (e.g. `"52% 9%"`), `avatarScale` is a multiplier

### Monologue Files

Each persona's internal monologue is stored separately from the chat:
```
chats/<sessionId>/monologue-<personaId>.json
```

Schema: `[{ "timestamp": ISO string, "text": string, "type": "think"|"research" }]`

Files are created on demand when a persona first thinks or researches. The GET /api/monologue endpoint serves these files to the frontend monologue modal.

### Avatar System

Avatar files live in `avatars/`. `AVATAR_PATHS` and `AVATAR_TUNING` constants in `app.js` map persona IDs to file paths and crop/zoom settings. Missing avatars fall back to initials. The `user` persona shows a star emblem instead of an image.

### localStorage Keys

| Key | Contents |
|-----|---------|
| `open-think-tank-chat-<id>` | Full session JSON for a chat |
| `open-think-tank-local-chats` | Registry of user-created chats |
| `open-think-tank-deleted-file-chats` | IDs of file-backed chats soft-deleted by user |
| `open-think-tank-auto-continue` | Auto-continue interval setting (OFF, 10s, 30s, 60s, 120s) |

### Adding a Seeded Chat

1. Create `chats/<new-id>/session-chat.json` with valid session JSON
2. Add an entry to `chats/index.json` with `id`, `name`, `startedAt`, `updatedAt`, `path`

### Next Milestones

See `project.md` for planned features: persistence backend, bot message API, realtime updates.
