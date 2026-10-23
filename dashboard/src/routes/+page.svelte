<script lang="ts">
	import { base } from '$app/paths';
	import { top, when } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const breakdowns = $derived([
		{ label: 'Types', counts: top(data.stats.types) },
		{ label: 'Topics', counts: top(data.stats.topics) },
		{ label: 'People mentioned', counts: top(data.stats.people) },
	]);
</script>

<svelte:head><title>Overview · Open Brain</title></svelte:head>

<h1 class="sr-only">Overview</h1>
<section class="space-y-8">
	<div class="grid gap-4 sm:grid-cols-3">
		<div class="bg-bg-card border border-white/10 rounded-xl p-5">
			<div class="text-sm text-text-muted">Thoughts</div>
			<div class="text-3xl font-semibold" data-testid="total">{data.stats.total.toLocaleString()}</div>
		</div>
		<div class="bg-bg-card border border-white/10 rounded-xl p-5">
			<div class="text-sm text-text-muted">Oldest</div>
			<div class="text-lg">{when(data.stats.oldest)}</div>
		</div>
		<div class="bg-bg-card border border-white/10 rounded-xl p-5">
			<div class="text-sm text-text-muted">Newest</div>
			<div class="text-lg">{when(data.stats.newest)}</div>
		</div>
	</div>

	<div class="grid gap-4 md:grid-cols-3">
		{#each breakdowns as b (b.label)}
			<!-- min-w-0: a grid item is as wide as its content otherwise, and a long name inside took the page with it. -->
			<div class="bg-bg-card border border-white/10 rounded-xl p-5 min-w-0">
				<h2 class="text-sm text-text-muted mb-3">{b.label}</h2>
				{#if b.counts.length === 0}
					<p class="text-sm text-text-muted">None recorded.</p>
				{:else}
					<ul class="space-y-1 text-sm">
						{#each b.counts as [name, n] (name)}
							<!-- min-w-0, so the name truncates in its row: a 22,000 px person's name scrolled the overview sideways (PR 2b review pass 1). -->
							<li class="flex justify-between gap-4"><span class="truncate min-w-0">{name}</span><span class="text-text-muted shrink-0">{n}</span></li>
						{/each}
					</ul>
				{/if}
			</div>
		{/each}
	</div>

	<div class="bg-bg-card border border-white/10 rounded-xl p-5">
		<h2 class="text-sm text-text-muted mb-3">Newest thoughts</h2>
		{#if data.recent.length === 0}
			<p class="text-sm text-text-muted">The brain holds no thoughts yet.</p>
		{:else}
			<!-- No preload on hover: a thought's page reads `fetch`, which the core logs as a click-through (034), so a hover would label one (review pass 1).
			     A full load on a click: the thought page is the server's alone (csr false), which a client-side navigation bypassed (review pass 5). -->
			<ul class="divide-y divide-white/5" data-testid="recent" data-sveltekit-preload-data="off" data-sveltekit-reload>
				{#each data.recent as t (t.id)}
					<li class="py-2 min-w-0">
						<!-- Wraps anywhere: a URL or hash in a first line scrolled the page sideways (review pass 6). -->
						<a class="hover:text-primary-light [overflow-wrap:anywhere]" href="{base}/thoughts/{t.id}">{t.line}</a>
						<div class="text-xs text-text-muted">{t.created_at ? when(t.created_at) : 'undated'}{t.superseded ? ' · superseded' : ''}</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>
