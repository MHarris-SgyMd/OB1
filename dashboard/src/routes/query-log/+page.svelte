<script lang="ts">
	import { base } from '$app/paths';
	import { when } from '$lib/format';
	import { tidy } from '$lib/tidy';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const tidyForm = tidy({ limit: '50' });
</script>

<svelte:head><title>Query log · Open Brain</title></svelte:head>

<section class="space-y-6">
	<h1 class="text-xl font-semibold">Query log</h1>

	<form method="GET" action="{base}/query-log" onformdata={tidyForm} class="bg-bg-card border border-white/10 rounded-xl p-5 grid gap-3 sm:grid-cols-3 text-sm items-end" data-testid="filters" data-sveltekit-keepfocus data-sveltekit-noscroll>
		<label class="flex flex-col gap-1">Logged after<input name="since" value={data.q.since ?? ''} class="field" placeholder="2026-10-23T08:00:00Z" autocomplete="off" /></label>
		<label class="flex flex-col gap-1">How many<input name="limit" type="number" min="1" max="1000" step="1" value={data.q.limit} class="field" /></label>
		<div><button type="submit" class="button">Apply</button></div>
	</form>

	<div class="bg-bg-card border border-white/10 rounded-xl p-5 space-y-3">
		{#if data.searches.length === 0}
			<p class="text-sm text-text-muted" data-testid="empty">No search is logged{data.q.since ? ' after that time' : ''}. Searches are logged where the operator has turned query_log on (<code>OB1_QUERY_LOG</code>).</p>
		{:else}
			<p class="text-sm text-text-muted">Most recent first: what each key searched, and how. Every key's searches show here to any key that can read.</p>
			<ol class="divide-y divide-white/5" data-testid="searches">
				{#each data.searches as s, i (i)}
					<li class="py-2 text-sm min-w-0 [overflow-wrap:anywhere]">
						<div>“{s.query}”</div>
						<div class="text-xs text-text-muted">
							{when(s.at)}{s.arm ? ` · ${s.arm}` : ''}{s.tier ? ` · ${s.tier}` : ''}{s.matches !== null ? ` · asked for ${s.matches}` : ''}{s.threshold !== null && s.threshold !== 0 ? ` · threshold ${s.threshold}` : ''}{s.recencyWeight ? ` · recency ${s.recencyWeight}` : ''}{s.filter ? ` · filter ${s.filter}` : ''}
						</div>
					</li>
				{/each}
			</ol>
			{#if data.truncated}
				<p class="text-sm text-text-muted" data-testid="truncated">More searches matched than are shown: raise How many, or set Logged after later.</p>
			{/if}
		{/if}
	</div>
</section>
