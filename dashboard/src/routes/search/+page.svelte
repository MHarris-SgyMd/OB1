<script lang="ts">
	import { base } from '$app/paths';
	import { when } from '$lib/format';
	import { SEARCH_SIZES } from '$lib/search';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	/** The menu's counts, and the address's own when it is another. */
	const sizes = $derived([...new Set([...SEARCH_SIZES, data.form.limit])].sort((a, b) => a - b));
	/**
	 * What a provider-down search matched (SMD-2891): the thoughts holding the
	 * query's identifiers or quoted spans, or else the query as one text — and,
	 * where nothing held either, that alone, never a claim of hits (review pass 2).
	 */
	const VECTORLESS: Record<string, string> = {
		literals: "The embedding provider did not answer: these thoughts hold the query's identifiers or quoted spans, matched exactly — nothing was ranked by meaning.",
		text: 'The embedding provider did not answer: these thoughts hold the query as one text, matched exactly — nothing was ranked by meaning.',
	};
	const NOTHING_HELD = "The embedding provider did not answer, and no thought holds the query's identifiers, quoted spans or text exactly. Try again later, or search by exact text.";
</script>

<svelte:head><title>Search · Open Brain</title></svelte:head>

<section class="space-y-6">
	<h1 class="text-xl font-semibold">Search</h1>

	<form method="GET" action="{base}/search" class="bg-bg-card border border-white/10 rounded-xl p-5 grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] items-end text-sm" data-testid="search-form">
		<label class="flex flex-col gap-1">Query<input name="q" value={data.form.query} class="field" maxlength="1000" autocomplete="off" /></label>
		<label class="flex flex-col gap-1">By
			<select name="mode" class="field">
				<option value="meaning" selected={data.form.mode === 'meaning'}>meaning</option>
				<option value="text" selected={data.form.mode === 'text'}>exact text</option>
			</select>
		</label>
		<label class="flex flex-col gap-1">Results
			<select name="limit" class="field">
				{#each sizes as n (n)}<option value={n} selected={data.form.limit === n}>{n}</option>{/each}
			</select>
		</label>
		<button type="submit" class="button">Search</button>
	</form>

	{#if data.hits !== null}
		<div class="bg-bg-card border border-white/10 rounded-xl p-5 space-y-3">
			{#if data.vectorless}
				<p class="text-sm text-amber-300" role="note" data-testid="vectorless">{data.hits.length > 0 ? (VECTORLESS[data.vectorless] ?? NOTHING_HELD) : NOTHING_HELD}</p>
			{/if}
			{#if data.hits.length === 0}
				<p class="text-sm text-text-muted" data-testid="no-hits">{data.offset > 0 ? 'No more matches.' : 'No thought matched.'}</p>
			{:else}
				{#if data.total !== null}
					<p class="text-sm text-text-muted" data-testid="total">{data.total.toLocaleString()} {data.total === 1 ? 'thought holds' : 'thoughts hold'} this text{data.offset > 0 ? `; from match ${(data.offset + 1).toLocaleString()}` : ''}.</p>
				{/if}
				<!-- As the overview's: no preload (a thought's page is a logged `fetch`, here a search's click-through), and a full load. -->
				<ul class="divide-y divide-white/5" data-testid="hits" data-sveltekit-preload-data="off" data-sveltekit-reload>
					{#each data.hits as h (h.id)}
						<li class="py-2 min-w-0">
							<a class="hover:text-primary-light [overflow-wrap:anywhere]" href="{base}/thoughts/{h.id}">{h.line}</a>
							<div class="text-xs text-text-muted [overflow-wrap:anywhere]">
								{h.created_at ? when(h.created_at) : 'undated'}{h.trust ? ` · ${h.trust}` : ''}{h.score !== null ? ` · similarity ${h.score.toFixed(2)}` : ''}{h.exact || (data.form.mode === 'meaning' && h.score === null) ? ' · exact match' : ''}{h.occurrences !== null ? ` · ${h.occurrences}×` : ''}{h.superseded ? ' · superseded' : ''}
							</div>
							{#if h.moved}<div class="text-xs text-amber-300 [overflow-wrap:anywhere]" data-testid="moved">⚠ Moved since written: {h.moved}</div>{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if data.links && (data.links.previous || data.links.next)}
				<!-- No preload: each page is a search, which the core may log. -->
				<nav class="flex gap-4 pt-2 text-sm" aria-label="Pages" data-testid="pages" data-sveltekit-preload-data="off">
					{#if data.links.previous}<a href={data.links.previous} rel="prev" class="text-text-muted hover:text-text" data-testid="previous">Previous</a>{/if}
					{#if data.links.next}<a href={data.links.next} rel="next" class="text-text-muted hover:text-text" data-testid="next">Next</a>{/if}
				</nav>
			{/if}
		</div>
	{/if}
</section>
