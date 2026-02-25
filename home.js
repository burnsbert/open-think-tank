const chatList = document.getElementById("chat-directory-list");
const createChatButton = document.getElementById("create-chat");

const CHAT_INDEX_PATH = "./chats/index.json";
const CHAT_STORAGE_PREFIX = "open-think-tank-chat-";
const LOCAL_CHATS_KEY = "open-think-tank-local-chats";
const DELETED_FILE_CHATS_KEY = "open-think-tank-deleted-file-chats";

function formatTimestamp(timestampIso) {
	try {
		return new Intl.DateTimeFormat([], {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit"
		}).format(new Date(timestampIso));
	} catch {
		return "Unknown";
	}
}

function getChatStorageKey(chatId) {
	return `${CHAT_STORAGE_PREFIX}${chatId}`;
}

function loadJsonFromStorage(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : fallback;
	} catch {
		return fallback;
	}
}

function saveJsonToStorage(key, value) {
	localStorage.setItem(key, JSON.stringify(value));
}

function createNewChatData(chatId, title) {
	const now = new Date().toISOString();
	return {
		formatVersion: "1.0",
		session: {
			id: chatId,
			title,
			startedAt: now,
			updatedAt: now,
			topic: "New think tank session"
		},
		personas: [
			{ id: "blake", name: "Blake", displayName: "Blake - The Pragmatist", role: "ai-persona", avatar: "./avatars/blake.jpg", avatarPosition: "52% 9%", avatarScale: 1.47, prioritizes: ["quality", "best practices", "business requirements"] },
			{ id: "yui", name: "Yui", displayName: "Yui - The User Champion", role: "ai-persona", avatar: "./avatars/yui.png", avatarPosition: "73% 5%", avatarScale: 2.05, prioritizes: ["user experience", "fun/exciting features", "consistency and polish"] },
			{ id: "grant", name: "Grant", displayName: "Grant - The Innovator", role: "ai-persona", avatar: "./avatars/grant.jpg", avatarPosition: "56% 4%", avatarScale: 2.09, prioritizes: ["innovation", "performance", "exciting features"] },
			{ id: "julia", name: "Julia", displayName: "Julia - The Strategist", role: "ai-persona", avatar: "./avatars/julia.jpg", avatarPosition: "25% 11%", avatarScale: 2.4, prioritizes: ["defining success", "pros/cons analysis", "creative compromises"] },
			{ id: "user", name: "You", displayName: "You", role: "human", avatar: "./avatars/user.png", avatarPosition: "50% 44%", avatarScale: 1.2, prioritizes: ["shipping quickly", "clear decisions"] }
		],
		notes: {
			content: "## Session Goals\n- "
		},
		messages: [
			{
				id: `msg-${Date.now()}`,
				speakerId: "julia",
				timestamp: now,
				text: "What does success look like for this new session?"
			}
		]
	};
}

async function loadFileChats() {
	try {
		const response = await fetch(CHAT_INDEX_PATH);
		if (!response.ok) {
			throw new Error("Unable to load file chats");
		}
		const data = await response.json();
		return data.chats || [];
	} catch {
		return [];
	}
}

function buildChatCard(chat) {
	const card = document.createElement("article");
	card.className = "chat-card";
	card.innerHTML = `
		<div class="chat-card-title-row">
			<h3>${chat.name}</h3>
			<span class="chat-card-time">${formatTimestamp(chat.updatedAt || chat.startedAt)}</span>
		</div>
		<p class="chat-card-meta">${chat.source === "local" ? "Local chat" : "File-backed chat"}</p>
		<div class="chat-card-actions">
			<a class="primary-btn secondary-link" href="./chat.html?id=${chat.id}">Continue</a>
			<button class="secondary-btn" type="button" data-action="delete" data-id="${chat.id}" data-source="${chat.source}">Delete</button>
		</div>
	`;
	return card;
}

function sortChats(chats) {
	return [...chats].sort((a, b) => {
		const at = new Date(a.updatedAt || a.startedAt || 0).getTime();
		const bt = new Date(b.updatedAt || b.startedAt || 0).getTime();
		return bt - at;
	});
}

async function renderChatDirectory() {
	const fileChats = await loadFileChats();
	const localChats = loadJsonFromStorage(LOCAL_CHATS_KEY, []);
	const deletedFileChatIds = new Set(loadJsonFromStorage(DELETED_FILE_CHATS_KEY, []));

	const visibleFileChats = fileChats
		.filter((chat) => !deletedFileChatIds.has(chat.id))
		.map((chat) => ({ ...chat, source: "file" }));

	const visibleLocalChats = localChats.map((chat) => ({ ...chat, source: "local" }));
	const allChats = sortChats([...visibleFileChats, ...visibleLocalChats]);

	if (!allChats.length) {
		chatList.innerHTML = `
			<div class="empty-state">
				<p class="empty-state-label">Start a new chat now</p>
				<button class="primary-btn primary-btn--lg" type="button" data-action="new-chat">New Chat</button>
			</div>`;
		return;
	}

	chatList.innerHTML = "";
	for (const chat of allChats) {
		chatList.append(buildChatCard(chat));
	}
}

function createChat() {
	const providedTitle = window.prompt("Name this new chat:", "New Think Tank Chat");
	if (providedTitle === null) {
		return;
	}

	const title = providedTitle.trim() || "New Think Tank Chat";
	const now = new Date().toISOString();
	const chatId = `local-${Date.now()}`;
	const localChats = loadJsonFromStorage(LOCAL_CHATS_KEY, []);

	localChats.push({
		id: chatId,
		name: title,
		startedAt: now,
		updatedAt: now
	});

	saveJsonToStorage(LOCAL_CHATS_KEY, localChats);
	saveJsonToStorage(getChatStorageKey(chatId), createNewChatData(chatId, title));
	window.location.href = `./chat.html?id=${chatId}`;
}

function deleteChat(chatId, source) {
	if (!window.confirm("Delete this chat?")) {
		return;
	}

	if (source === "local") {
		const localChats = loadJsonFromStorage(LOCAL_CHATS_KEY, []);
		const filtered = localChats.filter((chat) => chat.id !== chatId);
		saveJsonToStorage(LOCAL_CHATS_KEY, filtered);
		localStorage.removeItem(getChatStorageKey(chatId));
	} else {
		const deleted = loadJsonFromStorage(DELETED_FILE_CHATS_KEY, []);
		if (!deleted.includes(chatId)) {
			deleted.push(chatId);
		}
		saveJsonToStorage(DELETED_FILE_CHATS_KEY, deleted);
		localStorage.removeItem(getChatStorageKey(chatId));
	}

	renderChatDirectory();
}

chatList.addEventListener("click", (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) {
		return;
	}

	if (target.dataset.action === "new-chat") {
		createChat();
		return;
	}

	if (target.dataset.action !== "delete") {
		return;
	}

	const chatId = target.dataset.id;
	const source = target.dataset.source;
	if (!chatId || !source) {
		return;
	}

	deleteChat(chatId, source);
});

createChatButton.addEventListener("click", () => {
	createChat();
});

renderChatDirectory();
