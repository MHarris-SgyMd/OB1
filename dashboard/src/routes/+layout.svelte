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
		{ href: `${base}/status`, label: 'Status' },
	];
</script>

<div class="min-h-screen flex flex-col">
	<header class="border-b border-white/10 bg-bg-elevated/50 sticky top-0 z-50">
		<div class="max-w-5xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-3">
			<a href={HOME} class="flex items-center gap-3">
				<h1 class="text-xl font-bold">Open Brain</h1>
			</a>
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
						<a href={data.grafana} class="text-text-muted hover:text-text" rel="noopener noreferrer" target="_blank">Grafana ↗</a>
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

	<main class="flex-1 max-w-5xl w-full mx-auto px-6 py-8">
		{@render children()}
	</main>
</div>
