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
</script>

<div class="min-h-screen flex flex-col">
	<a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:m-2 focus:px-3 focus:py-2 focus:rounded focus:bg-bg-card">Skip to content</a>
	<!-- Opaque: a see-through header let the page scrolled under it read through (review pass 6). -->
	<header class="border-b border-white/10 bg-bg-elevated sticky top-0 z-50">
		<div class="max-w-5xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-3">
			<!-- The brand is no heading: each page has its one h1 (review pass 6). -->
			<a href={HOME} class="flex items-center gap-3 text-xl font-bold">Open Brain</a>
			{#if data.signedIn}
				<nav class="flex items-center gap-4 text-sm" aria-label="Views">
					{#each nav as item (item.href)}
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
