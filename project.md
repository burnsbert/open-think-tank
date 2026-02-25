# Open Think Tank - Project Plan

## Product Vision
Open Think Tank is a collaborative SaaS workspace where users run structured discussions with a room of AI personas while capturing project notes and decisions in parallel. The goal is to make ideation, tradeoff analysis, and decision tracking happen in one place.

## Core Experience
- Left panel: live multi-participant chat (user + AI personas)
- Right panel: editable notes/decisions for the current session
- Chat list home: continue existing chats, create new chats, delete chats
- Persona identity support: avatars, names, and role labels
- Theme support: light mode and dark mode

## Current State (Implemented)
- Multi-page web app with:
	- `index.html` (chat directory)
	- `chat.html` (session workspace)
- Chat storage model:
	- `chats/index.json` registry
	- `chats/<chat-id>/session-chat.json` per chat
	- localStorage overlays for edits/new chats in prototype mode
- Chat interactions:
	- User can send messages
	- `Enter` sends, `Shift+Enter` inserts newline
	- Session notes editable and persisted
- UX polish:
	- SaaS-style layout/navigation
	- Theme toggle (light/dark)
	- Persona hover cards with full identity labels
- Avatar system:
	- Persona-specific crop/zoom tuning
	- User avatar replaced with custom embossed star emblem

## Architecture Decisions
- Session JSON is the source-of-truth data shape for:
	- session metadata
	- personas
	- notes
	- messages
- Static front-end first, with API integration deferred
- File-backed seeded chats plus local persistence for fast iteration

## Next Milestones
1. Persistence Backend
	- Add local API/server to create/update/delete chat folders on disk
	- Replace localStorage-only operations with API calls
2. Bot Message Ingestion API
	- Define endpoint for bot agents to append messages
	- Validate payload schema and author identity
3. Realtime Updates
	- Add polling or websockets for live message updates
	- Handle optimistic UI for user sends
4. Session Management Hardening
	- Rename chats
	- Archive/unarchive chats
	- Search/filter chat list
5. Production Readiness
	- Authentication and workspace ownership
	- Error states/loading states
	- Observability and basic analytics

## Data Contract (Draft)
- `formatVersion`: schema version
- `session`: id, title, startedAt, updatedAt, topic
- `personas[]`: id, displayName, role, avatar, priorities, avatar tuning
- `notes`: markdown/plain text content
- `messages[]`: id, speakerId, timestamp, text

## Immediate TODOs
- Implement a small backend service for true file writes in `chats/`
- Add an API route for appending chat entries from external bot runners
- Add validation and migration utility for session JSON versions
- Add test coverage for:
	- chat creation/deletion flows
	- message append flow
	- theme persistence
	- persona rendering fallbacks

## Success Criteria (Phase 1)
- Users can reliably manage multiple chat sessions
- Chat + notes are both first-class and persist correctly
- Bots can post into chats through a stable API contract
- UI quality is credible as a production SaaS baseline

