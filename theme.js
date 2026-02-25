const THEME_STORAGE_KEY = "open-think-tank-theme";
const themeToggleButton = document.getElementById("theme-toggle");

function getSystemTheme() {
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStoredTheme() {
	const saved = localStorage.getItem(THEME_STORAGE_KEY);
	if (saved === "dark" || saved === "light") {
		return saved;
	}
	return null;
}

function updateToggleLabel(theme) {
	if (!themeToggleButton) {
		return;
	}

	const nextThemeLabel = theme === "dark" ? "Light Mode" : "Dark Mode";
	themeToggleButton.textContent = nextThemeLabel;
	themeToggleButton.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
}

function applyTheme(theme) {
	document.documentElement.setAttribute("data-theme", theme);
	localStorage.setItem(THEME_STORAGE_KEY, theme);
	updateToggleLabel(theme);
}

function initializeTheme() {
	const initialTheme = getStoredTheme() || getSystemTheme();
	applyTheme(initialTheme);
}

initializeTheme();

if (themeToggleButton) {
	themeToggleButton.addEventListener("click", () => {
		const currentTheme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
		const nextTheme = currentTheme === "dark" ? "light" : "dark";
		applyTheme(nextTheme);
	});
}
