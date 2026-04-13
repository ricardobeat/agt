let enabled = false;
const start = Date.now();

export function enableDebug() {
	enabled = true;
}

export function debug(msg) {
	if (!enabled) return;
	const elapsed = ((Date.now() - start) / 1000).toFixed(3);
	console.error(`  [${elapsed}s] ${msg}`);
}
