// The link to the telemetry dashboards (SMD-1849): the GUI links to Grafana
// and owns no telemetry of its own (ADR decision 2). Where Grafana answers is
// the overlays' to say, each on the `app` service:
//   - compose.grafana-port.yaml sets GRAFANA_LINK, /grafana/ on its loopback
//     origin, which is Grafana's root URL whenever that file is named;
//   - compose.grafana-public.yaml sets GRAFANA_ROUTE, /grafana/ on this origin.
// With both, the port's wins, whatever the -f order, since Grafana's root URL
// is its origin then (review pass 1). With neither, Grafana is reached
// nowhere, and there is no link.

/** The nav's link to Grafana: GRAFANA_LINK, else GRAFANA_ROUTE; null when neither is set or sound. */
export function grafanaUrl(env: Record<string, string | undefined>): string | null {
	return link(env.GRAFANA_LINK) ?? link(env.GRAFANA_ROUTE);
}

/** A path on this origin or an http(s) URL; null for anything else. No control character or space: a browser drops a tab or line break, so `/\t/host` would be `//host` (review pass 1). */
function link(value: string | undefined): string | null {
	const given = value?.trim();
	if (!given || /[\x00-\x20\x7f\\]/.test(given)) return null;
	if (given.startsWith('/')) return given.startsWith('//') ? null : given;
	try {
		const url = new URL(given);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
	} catch {
		return null;
	}
}
