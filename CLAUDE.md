# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

This is a static front-end with no build step. Serve files with any local HTTP server — file:// URLs won't work due to fetch() calls for JSON data.

```bash
# Python (recommended)
python3 -m http.server 8080

# Or npx
npx serve .
```

Then open `http://localhost:8080`.

## Architecture

**Two-page app with no framework or bundler.** All JS is vanilla ES modules loaded directly by the browser.

| File | Purpose |
|------|---------|
| `index.html` + `home.js` | Chat directory — lists, creates, deletes chats |
| `chat.html` + `app.js` | Session workspace — messages, notes, JSON preview |
| `theme.js` | Light/dark mode toggle (shared) |
| `styles.css` | All styles |

### Data Flow

`session-chat.json` is the canonical data shape. On load, `app.js` merges two sources:

1. **File-backed chats** — seeded JSON in `chats/<chat-id>/session-chat.json`, registered in `chats/index.json`
2. **localStorage overlay** — stored under key `open-think-tank-chat-<id>`; takes priority over file data

localStorage wins on conflict. This enables prototype editing without a backend.

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

### Avatar System

Avatar files live in `avatars/`. AVATAR_PATHS and AVATAR_TUNING constants in `app.js` map persona IDs to file paths and crop/zoom settings. Missing avatars fall back to initials. The `user` persona shows a star emblem instead of an image.

### localStorage Keys

| Key | Contents |
|-----|---------|
| `open-think-tank-chat-<id>` | Full session JSON for a chat |
| `open-think-tank-local-chats` | Registry of user-created chats |
| `open-think-tank-deleted-file-chats` | IDs of file-backed chats soft-deleted by user |

### Adding a Seeded Chat

1. Create `chats/<new-id>/session-chat.json` with valid session JSON
2. Add an entry to `chats/index.json` with `id`, `name`, `startedAt`, `updatedAt`, `path`

### Next Milestones

See `project.md` for planned features: persistence backend, bot message API, realtime updates.
