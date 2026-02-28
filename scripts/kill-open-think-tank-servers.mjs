import { execSync } from 'child_process';

const TARGET_PORTS = [3001, 8080];

function run(command) {
	try {
		return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return '';
	}
}

function getListeningPids(port) {
	const out = run(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
	if (!out) return [];
	return out
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => Number(line))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

function getProcessCommand(pid) {
	return run(`ps -p ${pid} -o command=`) || '';
}

function shouldKill(pid, command) {
	if (!command) return false;
	const normalized = command.toLowerCase();
	return (
		normalized.includes('open-think-tank')
		|| normalized.includes('node server.js')
		|| normalized.includes('python3 -m http.server 8080')
		|| normalized.includes('python -m http.server 8080')
	);
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killProcess(pid) {
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		return;
	}
	if (isAlive(pid)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// ignore if it exited between checks
		}
	}
}

const killed = [];

for (const port of TARGET_PORTS) {
	const pids = getListeningPids(port);
	for (const pid of pids) {
		const command = getProcessCommand(pid);
		if (!shouldKill(pid, command)) continue;
		killProcess(pid);
		killed.push({ pid, port, command });
	}
}

if (killed.length === 0) {
	console.log('[dev-cleanup] no prior open-think-tank servers found');
} else {
	for (const entry of killed) {
		console.log(`[dev-cleanup] killed pid=${entry.pid} port=${entry.port} cmd="${entry.command}"`);
	}
}
