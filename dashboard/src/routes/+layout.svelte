<script lang="ts">
	import '../app.css';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import { HOME } from '$lib/paths';
	import type { LayoutData } from './$types';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();
	const nav = [
		{ href: HOME, label: 'Overview' },
		{ href: `${base}/thoughts`, label: 'Browse' },
		{ href: `${base}/search`, label: 'Search' },
		{ href: `${base}/changes`, label: 'Changes' },
		{ href: `${base}/proposals`, label: 'Proposals' },
		{ href: `${base}/workers`, label: 'Workers' },
		{ href: `${base}/query-log`, label: 'Query log' },
		{ href: `${base}/status`, label: 'Status' },
	];
	// After the brain's own views: the page of grants where the session may use it (SMD-3307 PR 3), then the enabled
	// plugins' pages (SMD-2280 PR 3), as the registry labels them.
	// Capture beside the overview, for a session that may capture (SMD-3322): the one view that writes.
	const views = $derived([
		nav[0],
		...(data.canCapture ? [{ href: `${base}/capture`, label: 'Capture' }] : []),
		...nav.slice(1),
		...(data.grantsPage ? [{ href: `${base}/grants`, label: 'Grants' }] : []),
		...data.pluginPages,
	]);
</script>

<div class="min-h-screen flex flex-col">
	<a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:m-2 focus:px-3 focus:py-2 focus:rounded focus:bg-bg-card">Skip to content</a>
	<!-- Opaque: a see-through header let the page scrolled under it read through (review pass 6). -->
	<header class="border-b border-white/10 bg-bg-elevated sticky top-0 z-50">
		<div class="max-w-5xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-3">
			<!-- The brand is no heading: each page has its one h1 (review pass 6). -->
			<a href={HOME} class="flex items-center gap-3 text-xl font-bold">Open Brain</a>
			{#if data.signedIn}
				<!-- It wraps: eight views pushed it 218 px past a phone's width, and every page scrolled sideways (PR 2b review pass 1). -->
				<nav class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" aria-label="Views">
					{#each views as item (item.href)}
						<a
							href={item.href}
							class={page.url.pathname === item.href ? 'text-text' : 'text-text-muted hover:text-text'}
							aria-current={page.url.pathname === item.href ? 'page' : undefined}>{item.label}</a
						>
					{/each}
					{#if data.grafana}
						<a href={data.grafana} class="text-text-muted hover:text-text" rel="noopener noreferrer" target="_blank">Grafana<span aria-hidden="true"> ↗</span><span class="sr-only"> (opens a new tab)</span></a>
					{/if}
				</nav>
				<div class="flex items-center gap-3 text-sm">
					<span class="text-text-muted" data-testid="who">{data.name} · {data.canCapture ? 'write key' : 'read key'}</span>
					<form method="POST" action="{base}/signout">
						<button type="submit" class="text-text-muted hover:text-text">Sign out</button>
					</form>
				</div>
			{/if}
		</div>
	</header>

	<main id="main" class="flex-1 max-w-5xl w-full mx-auto px-6 py-8">
		{@render children()}
	</main>
</div>
