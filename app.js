const chatList = document.getElementById("chat-list");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const notesEditor = document.getElementById("notes-editor");
const jsonPreview = document.getElementById("json-preview");
const downloadButton = document.getElementById("download-session");
const pageTitle = document.getElementById("chat-page-title");

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
	return avatarWrap;
}

function renderMessages() {
	chatList.innerHTML = "";

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
	jsonPreview.textContent = JSON.stringify(sessionData, null, "\t");
}

function renderAll() {
	renderMessages();
	renderNotes();
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
	renderJsonPreview();
});

notesEditor.addEventListener("input", () => {
	if (!sessionData.notes) {
		sessionData.notes = { content: "" };
	}
	sessionData.notes.content = notesEditor.value;
	saveActiveChat();
	renderJsonPreview();
});

downloadButton.addEventListener("click", () => {
	downloadSession();
});

bootstrap();
