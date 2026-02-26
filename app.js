const chatList = document.getElementById("chat-list");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const notesEditor = document.getElementById("notes-editor");
const jsonPreview = document.getElementById("json-preview");
const downloadButton = document.getElementById("download-session");
const pageTitle = document.getElementById("chat-page-title");
const attachedFilesList = document.getElementById("attached-files-list");
const attachedDropzone = document.getElementById("attached-dropzone");
const attachedFilePicker = document.getElementById("attached-file-picker");
const attachedBrowseBtn = document.getElementById("attached-browse-btn");
const notesPanel = document.querySelector(".notes-panel");
const continueBtn = document.getElementById("continue-btn");
const autoContinueSelect = document.getElementById("auto-continue-select");
const modelSelect = document.getElementById("model-select");
const monologueModal = document.getElementById("monologue-modal");
const monologueTitle = document.getElementById("monologue-modal-title");
const monologueBody = document.getElementById("monologue-body");
const monologueBackdrop = monologueModal ? monologueModal.querySelector(".monologue-backdrop") : null;
const monologueCloseBtn = monologueModal ? monologueModal.querySelector(".monologue-close") : null;

const AUTO_CONTINUE_KEY = "open-think-tank-auto-continue";
const API_BASE_URL = "http://localhost:3001";

const CHAT_INDEX_PATH = "./chats/index.json";
const CHAT_STORAGE_PREFIX = "open-think-tank-chat-";
const AVATAR_PATHS = {
	blake: "./avatars/blake.jpg",
	yui: "./avatars/yui.png",
	grant: "./avatars/grant.jpg",
	julia: "./avatars/julia.jpg",
	user: "./avatars/user.png"
};
const AVATAR_TUNING = {
	blake: { position: "52% 9%", scale: 1.47 },
	yui: { position: "73% 5%", scale: 2.05 },
	grant: { position: "56% 4%", scale: 2.09 },
	julia: { position: "25% 11%", scale: 2.4 },
	user: { position: "50% 44%", scale: 1.2 }
};

let activeChatId = null;
let sessionData = null;
let turnMessageCount = 0;
let autoContinueTimerId = null;

function makeFallbackData() {
	return {
		formatVersion: "1.0",
		session: {
			id: "fallback-chat",
			title: "Fallback Chat",
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		},
		personas: [
			{ id: "blake", name: "Blake", displayName: "Blake - The Pragmatist", role: "ai-persona", avatar: AVATAR_PATHS.blake, avatarPosition: AVATAR_TUNING.blake.position, avatarScale: AVATAR_TUNING.blake.scale },
			{ id: "yui", name: "Yui", displayName: "Yui - The User Champion", role: "ai-persona", avatar: AVATAR_PATHS.yui, avatarPosition: AVATAR_TUNING.yui.position, avatarScale: AVATAR_TUNING.yui.scale },
			{ id: "grant", name: "Grant", displayName: "Grant - The Innovator", role: "ai-persona", avatar: AVATAR_PATHS.grant, avatarPosition: AVATAR_TUNING.grant.position, avatarScale: AVATAR_TUNING.grant.scale },
			{ id: "julia", name: "Julia", displayName: "Julia - The Strategist", role: "ai-persona", avatar: AVATAR_PATHS.julia, avatarPosition: AVATAR_TUNING.julia.position, avatarScale: AVATAR_TUNING.julia.scale },
			{ id: "user", name: "You", displayName: "You", role: "human", avatar: AVATAR_PATHS.user, avatarPosition: AVATAR_TUNING.user.position, avatarScale: AVATAR_TUNING.user.scale }
		],
		notes: {
			content: "Session notes go here."
		},
		attachedFiles: [],
		messages: [
			{
				id: "msg-fallback-1",
				speakerId: "blake",
				timestamp: new Date().toISOString(),
				text: "Fallback chat loaded."
			}
		]
	};
}

function getStorageKey(chatId) {
	return `${CHAT_STORAGE_PREFIX}${chatId}`;
}

function loadStoredChat(chatId) {
	try {
		const raw = localStorage.getItem(getStorageKey(chatId));
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function saveActiveChat() {
	if (!activeChatId || !sessionData) {
		return;
	}

	sessionData.session.updatedAt = new Date().toISOString();
	localStorage.setItem(getStorageKey(activeChatId), JSON.stringify(sessionData));
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function parsePosition(position) {
	const parts = String(position || "50% 50%").trim().split(/\s+/);
	return {
		x: clamp(Number.parseFloat(parts[0]) || 50, 0, 100),
		y: clamp(Number.parseFloat(parts[1]) || 50, 0, 100)
	};
}

function buildAvatarTransform(position, scale) {
	const xShift = (50 - position.x) * (scale - 1);
	const yShift = (50 - position.y) * (scale - 1);
	return `translate(${xShift.toFixed(2)}%, ${yShift.toFixed(2)}%) scale(${scale.toFixed(2)})`;
}

function applyPersonaDefaults() {
	if (!Array.isArray(sessionData.personas)) {
		return;
	}

	sessionData.personas = sessionData.personas.map((persona) => {
		const base = AVATAR_TUNING[persona.id];
		return {
			...persona,
			avatar: AVATAR_PATHS[persona.id] || persona.avatar,
			avatarPosition: persona.avatarPosition || (base ? base.position : "50% 50%"),
			avatarScale: typeof persona.avatarScale === "number" ? persona.avatarScale : (base ? base.scale : 1)
		};
	});
}

function getPersonaById(personaId) {
	return sessionData.personas.find((persona) => persona.id === personaId);
}

function formatTime(timestampIso) {
	try {
		return new Intl.DateTimeFormat([], {
			hour: "numeric",
			minute: "2-digit"
		}).format(new Date(timestampIso));
	} catch {
		return "";
	}
}

function getInitials(name) {
	return String(name || "")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((token) => token[0].toUpperCase())
		.join("");
}

/**
 * Close the monologue modal and restore focus.
 */
function closeMonologueModal() {
	if (!monologueModal) return;
	monologueModal.hidden = true;
	document.body.style.overflow = "";
	// Remove Escape key listener
	document.removeEventListener("keydown", handleMonologueEscape);
}

/**
 * Handle Escape key to close monologue modal.
 */
function handleMonologueEscape(event) {
	if (event.key === "Escape") {
		closeMonologueModal();
	}
}

/**
 * Build a single timeline entry DOM element for the monologue modal.
 *
 * @param {Object} entry — { type: "chat"|"think"|"research", text, speaker, timestamp, query?, findings? }
 * @returns {HTMLElement}
 */
function buildMonologueEntry(entry) {
	const el = document.createElement("div");
	el.className = "monologue-entry";

	const meta = document.createElement("div");
	meta.className = "monologue-entry-meta";

	const speaker = document.createElement("span");
	speaker.className = "monologue-entry-speaker";

	const time = document.createElement("time");
	time.className = "monologue-entry-time";
	time.dateTime = entry.timestamp || "";
	time.textContent = formatTime(entry.timestamp);

	if (entry.type === "think") {
		el.classList.add("monologue-entry--thought");
		speaker.textContent = "\uD83D\uDCAD " + (entry.speaker || "");
	} else if (entry.type === "research") {
		el.classList.add("monologue-entry--research");
		speaker.textContent = "\uD83D\uDD0D " + (entry.speaker || "");
	} else {
		// chat message
		speaker.textContent = entry.speaker || "";
	}

	meta.append(speaker, time);
	el.append(meta);

	if (entry.type === "research" && (entry.query || entry.findings)) {
		// Show query and findings as structured content
		if (entry.query) {
			const queryLabel = document.createElement("span");
			queryLabel.className = "monologue-entry-research-label";
			queryLabel.textContent = "Query";
			const queryText = document.createElement("p");
			queryText.className = "monologue-entry-text";
			queryText.textContent = entry.query;
			el.append(queryLabel, queryText);
		}
		if (entry.findings) {
			const findingsLabel = document.createElement("span");
			findingsLabel.className = "monologue-entry-research-label";
			findingsLabel.textContent = "Findings";
			const findingsText = document.createElement("p");
			findingsText.className = "monologue-entry-text";
			findingsText.textContent = entry.findings;
			el.append(findingsLabel, findingsText);
		}
	} else {
		const text = document.createElement("p");
		text.className = "monologue-entry-text";
		text.textContent = entry.text || "";
		el.append(text);
	}

	return el;
}

/**
 * Open the monologue modal for a given persona.
 * Fetches monologue data from the server, merges with chat messages,
 * and displays a chronological timeline of all session activity for that persona.
 *
 * @param {string} personaId — the persona whose monologue to display
 */
async function openMonologueModal(personaId) {
	if (!monologueModal || !monologueBody || !monologueTitle) return;

	const persona = getPersonaById(personaId);
	const displayName = persona ? (persona.displayName || persona.name) : personaId;
	const speakerName = persona ? persona.name : personaId;

	// Set the modal header title
	monologueTitle.textContent = displayName + " — Monologue";

	// Clear the "has-new-thoughts" badge for this persona (user has "read" the thoughts)
	const badges = document.querySelectorAll(`.thought-badge[data-persona-id="${personaId}"]`);
	for (const badge of badges) {
		badge.classList.remove("has-new-thoughts");
	}

	// Clear previous body content
	monologueBody.innerHTML = "";

	// Show modal immediately (loading state)
	monologueModal.hidden = false;
	document.body.style.overflow = "hidden";
	document.addEventListener("keydown", handleMonologueEscape);

	// Fetch monologue data from server (gracefully handle failure)
	let monologueEntries = [];
	try {
		const response = await fetch(`${API_BASE_URL}/api/monologue/${activeChatId}/${personaId}`);
		if (response.ok) {
			monologueEntries = await response.json();
		}
	} catch {
		// Server unavailable or endpoint not built yet — continue with empty monologue
	}

	// Gather chat messages for this persona from sessionData
	const chatMessages = (sessionData.messages || [])
		.filter((msg) => msg.speakerId === personaId)
		.map((msg) => ({
			type: "chat",
			text: msg.text,
			speaker: speakerName,
			timestamp: msg.timestamp
		}));

	// Convert monologue entries to timeline format
	const monologueItems = (monologueEntries || []).map((entry) => {
		// Monologue entries from persistence have: { timestamp, text, type }
		// Research entries may have combined text like "Research: query\nFindings: findings"
		const item = {
			type: entry.type || "think",
			text: entry.text || "",
			speaker: speakerName,
			timestamp: entry.timestamp
		};

		// If research type, try to parse query/findings from text
		if (item.type === "research" && item.text) {
			const researchMatch = item.text.match(/^Research:\s*(.*?)(?:\nFindings:\s*(.*))?$/s);
			if (researchMatch) {
				item.query = researchMatch[1] ? researchMatch[1].trim() : "";
				item.findings = researchMatch[2] ? researchMatch[2].trim() : "";
			}
		}

		return item;
	});

	// Merge and sort by timestamp chronologically
	const timeline = [...chatMessages, ...monologueItems].sort((a, b) => {
		const dateA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
		const dateB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
		return dateA - dateB;
	});

	// Render the timeline
	monologueBody.innerHTML = "";

	if (timeline.length === 0) {
		const empty = document.createElement("div");
		empty.className = "monologue-empty";
		empty.textContent = "No activity yet for " + speakerName + ".";
		monologueBody.append(empty);
	} else {
		for (const entry of timeline) {
			monologueBody.append(buildMonologueEntry(entry));
		}
	}
}

/**
 * Mark all thought badges for a persona with the "has-new-thoughts" class,
 * triggering the pulse animation. This is called when a think/research
 * SSE event arrives for that persona.
 *
 * @param {string} personaId — the persona with new monologue entries
 */
function markPersonaNewThoughts(personaId) {
	const badges = document.querySelectorAll(`.thought-badge[data-persona-id="${personaId}"]`);
	for (const badge of badges) {
		badge.classList.add("has-new-thoughts");
	}
}

function buildAvatar(persona) {
	const avatarWrap = document.createElement("div");
	const avatarClip = document.createElement("div");
	const image = document.createElement("img");
	const fallback = document.createElement("span");
	const preview = document.createElement("div");
	const previewMedia = document.createElement("div");
	const previewImage = document.createElement("img");
	const previewFallback = document.createElement("span");
	const previewLabel = document.createElement("div");
	const position = parsePosition(persona.avatarPosition);
	const scale = Number(persona.avatarScale || 1);
	const isUserPersona = persona.id === "user";
	const isAiPersona = persona.role === "ai-persona";

	avatarWrap.className = "avatar-wrap";
	avatarClip.className = "avatar-clip";
	image.className = "avatar-image";
	image.src = persona.avatar;
	image.alt = `${persona.name} avatar`;
	image.loading = "lazy";
	image.style.objectPosition = "50% 50%";
	image.style.transform = buildAvatarTransform(position, scale);

	fallback.className = "avatar-fallback";
	fallback.textContent = getInitials(persona.name);
	fallback.style.display = "none";
	if (isUserPersona) {
		fallback.classList.add("user-star-avatar");
		fallback.textContent = "★";
		fallback.style.display = "inline-flex";
		image.style.display = "none";
	}

	preview.className = "avatar-preview";
	previewMedia.className = "avatar-preview-media";
	previewImage.className = "avatar-preview-image";
	previewImage.src = persona.avatar;
	previewImage.alt = "";
	previewImage.loading = "lazy";
	previewFallback.className = "avatar-preview-fallback";
	previewFallback.textContent = getInitials(persona.name);
	previewFallback.style.display = "none";
	if (isUserPersona) {
		previewFallback.classList.add("user-star-preview");
		previewFallback.textContent = "★";
		previewFallback.style.display = "inline-flex";
		previewImage.style.display = "none";
	}
	previewLabel.className = "avatar-preview-label";
	previewLabel.textContent = persona.displayName || persona.name;

	image.addEventListener("error", () => {
		image.style.display = "none";
		fallback.style.display = "inline-flex";
		previewImage.style.display = "none";
		previewFallback.style.display = "inline-flex";
	});

	previewMedia.append(previewImage, previewFallback);
	preview.append(previewMedia, previewLabel);
	avatarClip.append(image, fallback);
	avatarWrap.append(avatarClip, preview);

	// Add thought bubble badge for AI personas only
	if (isAiPersona) {
		const badge = document.createElement("button");
		badge.className = "thought-badge";
		badge.type = "button";
		badge.setAttribute("data-persona-id", persona.id);
		badge.setAttribute("aria-label", `View ${persona.name}'s monologue`);
		badge.textContent = "\uD83D\uDCAD";
		badge.addEventListener("click", (event) => {
			event.stopPropagation();
			openMonologueModal(persona.id);
		});
		avatarWrap.append(badge);
	}

	return avatarWrap;
}

function renderParticipants() {
	const aiPersonas = (sessionData.personas || []).filter(
		(p) => p.role !== "human"
	);
	if (aiPersonas.length === 0) {
		return null;
	}

	const roster = document.createElement("div");
	roster.className = "participant-roster";
	roster.setAttribute("role", "status");
	roster.setAttribute("aria-label", "Chat participants");

	const label = document.createElement("p");
	label.className = "participant-roster-label";
	label.textContent = "The following participants are in the chat:";

	const avatarRow = document.createElement("div");
	avatarRow.className = "participant-roster-avatars";

	for (const persona of aiPersonas) {
		avatarRow.append(buildAvatar(persona));
	}

	roster.append(label, avatarRow);
	return roster;
}

/**
 * Build a single message DOM element and append it to #chat-list.
 * Mirrors the DOM structure created per-message in renderMessages():
 *   article.message > buildAvatar() + div.message-content > (div.message-meta + p.text)
 * Used during SSE turns for smooth incremental delivery without full re-render.
 *
 * @param {Object} message — a message object with { speakerId, timestamp, text }
 */
function appendMessage(message) {
	// Look up persona; gracefully fall back if missing
	const persona = getPersonaById(message.speakerId);
	const name = persona ? persona.name : message.speakerId;
	const isHuman = persona ? persona.role === "human" : false;

	const row = document.createElement("article");
	row.className = `message ${isHuman ? "user" : ""}`;

	const content = document.createElement("div");
	const meta = document.createElement("div");
	const speaker = document.createElement("span");
	const timestamp = document.createElement("time");
	const text = document.createElement("p");

	content.className = "message-content";
	meta.className = "message-meta";
	speaker.className = "speaker";
	speaker.textContent = name;
	timestamp.className = "timestamp";
	timestamp.dateTime = message.timestamp;
	timestamp.textContent = formatTime(message.timestamp);
	text.className = "text";
	text.textContent = message.text;

	meta.append(speaker, timestamp);
	content.append(meta, text);

	if (persona) {
		const avatar = buildAvatar(persona);
		if (isHuman) {
			row.append(content, avatar);
		} else {
			row.append(avatar, content);
		}
	} else {
		// No persona found — render content only (no avatar)
		row.append(content);
	}

	chatList.append(row);
	chatList.scrollTop = chatList.scrollHeight;
}

/**
 * Show a "thinking" indicator for a persona in the chat list.
 * Creates a temporary row with the persona's avatar and animated dots.
 * Identified by data-thinking-persona attribute for later removal.
 *
 * @param {string} personaId — the persona currently thinking
 * @param {string} personaName — display name for the meta line
 */
function showThinkingIndicator(personaId, personaName) {
	// Remove any existing indicator for this persona first (safety)
	removeThinkingIndicator(personaId);

	const persona = getPersonaById(personaId);
	const name = personaName || (persona ? persona.name : personaId);

	const row = document.createElement("article");
	row.className = "thinking-indicator";
	row.setAttribute("data-thinking-persona", personaId);
	row.setAttribute("aria-label", `${name} is thinking`);

	const content = document.createElement("div");
	const meta = document.createElement("div");
	const speaker = document.createElement("span");
	const dots = document.createElement("div");

	content.className = "message-content";
	meta.className = "message-meta";
	speaker.className = "speaker";
	speaker.textContent = name;

	dots.className = "thinking-dots";
	dots.setAttribute("aria-hidden", "true");
	for (let i = 0; i < 3; i++) {
		dots.append(document.createElement("span"));
	}

	meta.append(speaker);
	content.append(meta, dots);

	if (persona) {
		const avatar = buildAvatar(persona);
		row.append(avatar, content);
	} else {
		row.append(content);
	}

	chatList.append(row);
	chatList.scrollTop = chatList.scrollHeight;
}

/**
 * Remove the thinking indicator for a specific persona.
 *
 * @param {string} personaId — the persona whose indicator to remove
 */
function removeThinkingIndicator(personaId) {
	const indicator = chatList.querySelector(
		`[data-thinking-persona="${personaId}"]`
	);
	if (indicator) {
		indicator.remove();
	}
}

/**
 * Remove ALL thinking indicators from the chat list (cleanup on turn end).
 */
function removeAllThinkingIndicators() {
	const indicators = chatList.querySelectorAll("[data-thinking-persona]");
	for (const el of indicators) {
		el.remove();
	}
}

function renderMessages() {
	chatList.innerHTML = "";

	const roster = renderParticipants();
	if (roster) {
		chatList.append(roster);
	}

	for (const message of sessionData.messages || []) {
		const persona = getPersonaById(message.speakerId);
		if (!persona) {
			continue;
		}

		const row = document.createElement("article");
		row.className = `message ${persona.role === "human" ? "user" : ""}`;
		const avatar = buildAvatar(persona);
		const content = document.createElement("div");
		const meta = document.createElement("div");
		const speaker = document.createElement("span");
		const timestamp = document.createElement("time");
		const text = document.createElement("p");

		content.className = "message-content";
		meta.className = "message-meta";
		speaker.className = "speaker";
		speaker.textContent = persona.name;
		timestamp.className = "timestamp";
		timestamp.dateTime = message.timestamp;
		timestamp.textContent = formatTime(message.timestamp);
		text.className = "text";
		text.textContent = message.text;

		meta.append(speaker, timestamp);
		content.append(meta, text);
		if (persona.role === "human") {
			row.append(content, avatar);
		} else {
			row.append(avatar, content);
		}
		chatList.append(row);
	}

	chatList.scrollTop = chatList.scrollHeight;
}

function renderNotes() {
	notesEditor.value = sessionData.notes?.content || "";
}

function renderJsonPreview() {
	if (!jsonPreview) return;
	jsonPreview.textContent = JSON.stringify(sessionData, null, "\t");
}

function renderAttachedFiles() {
	const files = sessionData.attachedFiles || [];
	attachedFilesList.innerHTML = "";

	for (const path of files) {
		const filename = path.split(/[/\\]/).pop() || path;

		const li = document.createElement("li");
		li.className = "attached-file-item";

		const nameEl = document.createElement("span");
		nameEl.className = "attached-file-name";
		nameEl.textContent = filename;
		nameEl.title = path;

		const pathEl = document.createElement("span");
		pathEl.className = "attached-file-path";
		pathEl.textContent = path;

		const removeBtn = document.createElement("button");
		removeBtn.className = "attached-file-remove";
		removeBtn.type = "button";
		removeBtn.textContent = "×";
		removeBtn.setAttribute("aria-label", `Remove ${filename}`);
		removeBtn.addEventListener("click", () => removeAttachedFile(path));

		li.append(nameEl, pathEl, removeBtn);
		attachedFilesList.append(li);
	}
}

function addAttachedFile(rawPath) {
	const path = rawPath.trim();
	if (!path) return;

	if (!Array.isArray(sessionData.attachedFiles)) {
		sessionData.attachedFiles = [];
	}

	if (!sessionData.attachedFiles.includes(path)) {
		sessionData.attachedFiles.push(path);
		saveActiveChat();
		renderAttachedFiles();
	}

	attachedPathInput.value = "";
	attachedAddRow.hidden = true;
}

function removeAttachedFile(path) {
	if (!Array.isArray(sessionData.attachedFiles)) return;
	sessionData.attachedFiles = sessionData.attachedFiles.filter((f) => f !== path);
	saveActiveChat();
	renderAttachedFiles();
}

function renderAll() {
	renderMessages();
	renderNotes();
	renderAttachedFiles();
	renderJsonPreview();
	if (pageTitle) {
		pageTitle.textContent = sessionData.session?.title || "Open Think Tank Session";
	}
}

function appendUserMessage(text) {
	if (!Array.isArray(sessionData.messages)) {
		sessionData.messages = [];
	}

	sessionData.messages.push({
		id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		speakerId: "user",
		timestamp: new Date().toISOString(),
		text
	});
}

function downloadSession() {
	const blob = new Blob([JSON.stringify(sessionData, null, "\t")], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `session-${activeChatId || "chat"}.json`;
	link.click();
	URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------
   SSE Client & Turn Trigger
   --------------------------------------------------------------- */

/**
 * Parse a buffer of SSE text into discrete events.
 * SSE frames are separated by double-newline (\n\n).
 * Each frame contains lines like:
 *   event: <type>
 *   data: <json>
 *
 * Returns { events: Array<{event, data}>, remainder: string }
 * where remainder is any incomplete frame text left over.
 */
function parseSseBuffer(buffer) {
	const events = [];
	const frames = buffer.split("\n\n");
	// The last element may be an incomplete frame
	const remainder = frames.pop();

	for (const frame of frames) {
		if (!frame.trim()) continue;

		let eventType = "";
		let dataStr = "";

		for (const line of frame.split("\n")) {
			if (line.startsWith("event:")) {
				eventType = line.slice("event:".length).trim();
			} else if (line.startsWith("data:")) {
				dataStr = line.slice("data:".length).trim();
			}
		}

		if (eventType && dataStr) {
			try {
				events.push({ event: eventType, data: JSON.parse(dataStr) });
			} catch {
				console.error("[SSE] Failed to parse data for event:", eventType, dataStr);
			}
		}
	}

	return { events, remainder: remainder || "" };
}

/**
 * Trigger a full turn (round) of persona responses.
 * Sends POST /api/turn with the current session state, then reads
 * the SSE response stream using a manual parser (cannot use EventSource
 * because this is a POST request).
 */
async function triggerTurn() {
	// Prevent concurrent turns — if button is already disabled, bail out
	if (continueBtn.disabled) {
		return;
	}

	// Clear auto-continue timer during the turn — it will be reset on 'done'
	clearAutoContinueTimer();

	// Disable Continue button and show spinner (CSS handles spinner display)
	continueBtn.disabled = true;
	turnMessageCount = 0;

	try {
		const response = await fetch(`${API_BASE_URL}/api/turn`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionId: activeChatId,
				messages: sessionData.messages,
				notes: sessionData.notes?.content || "",
				attachedFiles: sessionData.attachedFiles || [],
				model: modelSelect ? modelSelect.value : "sonnet",
				personas: sessionData.personas
			})
		});

		if (!response.ok) {
			const errBody = await response.json().catch(() => ({}));
			console.error("[triggerTurn] Server error:", response.status, errBody.error || response.statusText);
			return;
		}

		// Read the SSE stream using getReader() + TextDecoder
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let sseBuffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			sseBuffer += decoder.decode(value, { stream: true });
			const { events, remainder } = parseSseBuffer(sseBuffer);
			sseBuffer = remainder;

			for (const { event, data } of events) {
				handleSseEvent(event, data);
			}
		}

		// Process any trailing data in the buffer
		if (sseBuffer.trim()) {
			const { events } = parseSseBuffer(sseBuffer + "\n\n");
			for (const { event, data } of events) {
				handleSseEvent(event, data);
			}
		}
	} catch (err) {
		console.error("[triggerTurn] Network/fetch error:", err);
	} finally {
		// Always re-enable the Continue button
		continueBtn.disabled = false;
	}
}

/**
 * Handle a single SSE event from the server.
 *
 * Event types:
 *   thinking — a persona is generating a response
 *   message  — a persona finished (speak, think, or research)
 *   notes    — session notes were updated by a persona
 *   done     — the turn (round) is complete
 *   error    — an error occurred for a persona
 */
function handleSseEvent(eventType, data) {
	switch (eventType) {
		case "thinking":
			showThinkingIndicator(data.personaId, data.personaName);
			break;

		case "message":
			// Remove thinking indicator for this persona before rendering
			removeThinkingIndicator(data.personaId);

			if (data.action === "speak" && data.message) {
				// Append the spoken message to sessionData and render incrementally
				sessionData.messages.push(data.message);
				appendMessage(data.message);
				turnMessageCount++;
			} else {
				// think/research actions go to monologue only — log for debugging
				console.log(`[message] ${data.personaId} performed: ${data.action}`);
				// Pulse the thought badges for this persona to indicate new monologue
				markPersonaNewThoughts(data.personaId);
			}
			// Reset auto-continue timer on any incoming message (speak, think, or research)
			resetAutoContinueTimer();
			break;

		case "notes":
			// Update the notes content in session data and the editor
			if (data.content != null) {
				if (!sessionData.notes) {
					sessionData.notes = { content: "" };
				}
				sessionData.notes.content = data.content;
				// Preserve user's scroll position while updating content
				const prevScrollTop = notesEditor.scrollTop;
				notesEditor.value = data.content;
				notesEditor.scrollTop = prevScrollTop;
				// Persist the updated notes to localStorage
				saveActiveChat();
			}
			break;

		case "done":
			// Clean up any remaining thinking indicators
			removeAllThinkingIndicators();

			// Turn complete — save the updated session to localStorage
			saveActiveChat();
			// Re-render to ensure everything is in sync
			renderMessages();
			renderJsonPreview();

			// If no messages were added during the round, show a system notice
			// (appended after renderMessages so it isn't wiped by the full re-render)
			if (turnMessageCount === 0) {
				const notice = document.createElement("div");
				notice.className = "system-notice";
				notice.setAttribute("role", "status");
				notice.textContent = "All personas are thinking quietly this round.";
				chatList.append(notice);
				chatList.scrollTop = chatList.scrollHeight;
			}

			// Reset auto-continue timer after turn completes
			resetAutoContinueTimer();
			break;

		case "error":
			// Remove thinking indicator for the errored persona
			if (data.personaId) {
				removeThinkingIndicator(data.personaId);
			}
			console.error(`[SSE error] persona=${data.personaId}:`, data.error);
			break;

		default:
			console.warn("[SSE] Unknown event type:", eventType, data);
			break;
	}
}

/* ---------------------------------------------------------------
   Auto-Continue Timer
   --------------------------------------------------------------- */

/**
 * Clear the auto-continue timer without starting a new one.
 * Called when: auto-continue is set to OFF, or a turn starts.
 */
function clearAutoContinueTimer() {
	if (autoContinueTimerId !== null) {
		clearTimeout(autoContinueTimerId);
		autoContinueTimerId = null;
	}
}

/**
 * Reset (clear + restart) the auto-continue timer based on the current
 * select value. If the select value is "0" (OFF), just clears any existing
 * timer. Otherwise, starts a new setTimeout for the selected interval.
 *
 * When the timer fires:
 *   - If the Continue button is disabled (turn in progress), do nothing.
 *     The timer will be reset again when the turn finishes (done event).
 *   - Otherwise, call triggerTurn() to start a new turn.
 *
 * Uses setTimeout (not setInterval) — fires once, then is reset by the
 * next event (user message, SSE message, or turn done).
 */
function resetAutoContinueTimer() {
	clearAutoContinueTimer();

	if (!autoContinueSelect) return;

	const intervalSeconds = parseInt(autoContinueSelect.value, 10);
	if (!intervalSeconds || intervalSeconds <= 0) return;

	autoContinueTimerId = setTimeout(() => {
		autoContinueTimerId = null;
		// Don't fire during an active turn
		if (continueBtn && continueBtn.disabled) return;
		triggerTurn();
	}, intervalSeconds * 1000);
}

async function loadChatIndex() {
	try {
		const response = await fetch(CHAT_INDEX_PATH);
		if (!response.ok) {
			throw new Error("Unable to load chat index");
		}
		return await response.json();
	} catch {
		return { chats: [] };
	}
}

async function loadFileBackedChat(chatId, chatIndex) {
	const selected = (chatIndex.chats || []).find((chat) => chat.id === chatId);
	if (!selected) {
		return null;
	}

	try {
		const response = await fetch(selected.path);
		if (!response.ok) {
			throw new Error("Unable to fetch chat");
		}
		const loaded = await response.json();
		if (!loaded.session) {
			loaded.session = {};
		}
		loaded.session.title = loaded.session.title || selected.name;
		loaded.session.id = loaded.session.id || selected.id;
		return loaded;
	} catch {
		return null;
	}
}

async function bootstrap() {
	const params = new URLSearchParams(window.location.search);
	const requestedChatId = params.get("id");
	const chatIndex = await loadChatIndex();
	const defaultChatId = chatIndex.chats?.[0]?.id || "fallback";
	activeChatId = requestedChatId || defaultChatId;

	const stored = loadStoredChat(activeChatId);
	const fileData = stored ? null : await loadFileBackedChat(activeChatId, chatIndex);
	sessionData = stored || fileData || makeFallbackData();
	applyPersonaDefaults();
	saveActiveChat();
	renderAll();
}

chatInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		chatForm.requestSubmit();
	}
});

chatForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const messageText = chatInput.value.trim();
	if (!messageText) {
		return;
	}

	appendUserMessage(messageText);
	chatInput.value = "";
	saveActiveChat();
	renderMessages();
	// Reset auto-continue timer after user sends a message
	resetAutoContinueTimer();
});

notesEditor.addEventListener("input", () => {
	if (!sessionData.notes) {
		sessionData.notes = { content: "" };
	}
	sessionData.notes.content = notesEditor.value;
	saveActiveChat();
});

downloadButton.addEventListener("click", () => {
	downloadSession();
});

// Auto-continue persistence and timer control
if (autoContinueSelect) {
	const savedAutoContinue = localStorage.getItem(AUTO_CONTINUE_KEY);
	if (savedAutoContinue !== null) {
		autoContinueSelect.value = savedAutoContinue;
	}
	autoContinueSelect.addEventListener("change", () => {
		localStorage.setItem(AUTO_CONTINUE_KEY, autoContinueSelect.value);
		const interval = parseInt(autoContinueSelect.value, 10);
		if (!interval || interval <= 0) {
			// OFF selected — clear the timer
			clearAutoContinueTimer();
		} else {
			// New interval selected — reset the timer
			resetAutoContinueTimer();
		}
	});
}

// Continue button click handler
if (continueBtn) {
	continueBtn.addEventListener("click", triggerTurn);
}

// Monologue modal close handlers
if (monologueBackdrop) {
	monologueBackdrop.addEventListener("click", closeMonologueModal);
}
if (monologueCloseBtn) {
	monologueCloseBtn.addEventListener("click", closeMonologueModal);
}

// File picker (native OS dialog)
async function browseFiles() {
	if ("showOpenFilePicker" in window) {
		try {
			const handles = await window.showOpenFilePicker({ multiple: true });
			for (const handle of handles) {
				addAttachedFile(handle.name);
			}
		} catch {
			// user cancelled
		}
	} else {
		attachedFilePicker.click();
	}
}

attachedBrowseBtn.addEventListener("click", browseFiles);
attachedDropzone.addEventListener("click", (event) => {
	if (event.target !== attachedBrowseBtn) browseFiles();
});

attachedFilePicker.addEventListener("change", () => {
	for (const file of attachedFilePicker.files) {
		addAttachedFile(file.name);
	}
	attachedFilePicker.value = "";
});

// Drag and drop — highlight when dragging over the whole notes panel
let dragCounter = 0;

notesPanel.addEventListener("dragenter", (event) => {
	if (!event.dataTransfer.types.includes("Files")) return;
	event.preventDefault();
	dragCounter++;
	attachedDropzone.classList.add("drag-over");
});

notesPanel.addEventListener("dragleave", () => {
	dragCounter--;
	if (dragCounter === 0) {
		attachedDropzone.classList.remove("drag-over");
	}
});

notesPanel.addEventListener("dragover", (event) => {
	if (!event.dataTransfer.types.includes("Files")) return;
	event.preventDefault();
});

notesPanel.addEventListener("drop", (event) => {
	event.preventDefault();
	dragCounter = 0;
	attachedDropzone.classList.remove("drag-over");
	for (const file of event.dataTransfer.files) {
		addAttachedFile(file.name);
	}
});

bootstrap();
