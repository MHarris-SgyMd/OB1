// The link to the telemetry dashboards (SMD-1849): the GUI links to Grafana
// and owns no telemetry of its own (ADR decision 2). Where Grafana answers is
// the overlay's to say — /grafana/ on this origin with
// compose.grafana-public.yaml, /grafana/ on its loopback origin with
// compose.grafana-port.yaml — and each sets GRAFANA_LINK on the `app`
// service; with neither, Grafana is reached nowhere, and there is no link.

/** GRAFANA_LINK as a link: a path on this origin, or an http(s) URL; null when unset or neither. */
export function grafanaUrl(env: Record<string, string | undefined>): string | null {
	const given = env.GRAFANA_LINK?.trim();
	if (!given) return null;
	if (given.startsWith('/') && !given.startsWith('//') && !given.includes('\\')) return given;
	try {
		const url = new URL(given);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
	} catch {
		return null;
	}
}
