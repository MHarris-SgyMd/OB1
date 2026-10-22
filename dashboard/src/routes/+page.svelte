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
			<div class="bg-bg-card border border-white/10 rounded-xl p-5">
				<h2 class="text-sm text-text-muted mb-3">{b.label}</h2>
				{#if b.counts.length === 0}
					<p class="text-sm text-text-muted">None recorded.</p>
				{:else}
					<ul class="space-y-1 text-sm">
						{#each b.counts as [name, n] (name)}
							<li class="flex justify-between gap-4"><span class="truncate">{name}</span><span class="text-text-muted">{n}</span></li>
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
			<!-- No preload on hover: a thought's page reads `fetch`, which the core logs as a click-through (034), so a hover would label one (review pass 1). -->
			<ul class="divide-y divide-white/5" data-testid="recent" data-sveltekit-preload-data="off">
				{#each data.recent as t (t.id)}
					<li class="py-2">
						<a class="hover:text-primary-light" href="{base}/thoughts/{t.id}">{t.line}</a>
						<div class="text-xs text-text-muted">{t.created_at ? when(t.created_at) : 'undated'}{t.superseded ? ' · superseded' : ''}</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>
