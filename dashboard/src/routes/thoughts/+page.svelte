<script lang="ts">
	import { base } from '$app/paths';
	import { PAGE_SIZES, TRUST_WORDS } from '$lib/browse';
	import { when } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	/** A filter applies when it is left or Enter is pressed (the form's own submit); a choice, when it is made. */
	const apply = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLSelectElement).form?.requestSubmit();
	/** The menu's sizes, and the address's own when it is another (a shared link keeps its size). */
	const sizes = $derived([...new Set([...PAGE_SIZES, data.q.limit])].sort((a, b) => a - b));
	const filtered = $derived(['type', 'topic', 'person', 'actor', 'said_by', 'min_trust', 'days'].some((k) => data.q[k as keyof typeof data.q] !== undefined));
</script>

<svelte:head><title>Browse · Open Brain</title></svelte:head>

<section class="space-y-6">
	<h1 class="text-xl font-semibold">Browse</h1>

	<!-- A GET form: its fields are the address, and a new filter starts at the first page (no cursor rides it). -->
	<form method="GET" action="{base}/thoughts" class="bg-bg-card border border-white/10 rounded-xl p-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm" data-testid="filters">
		<label class="flex flex-col gap-1">Type<input name="type" value={data.q.type ?? ''} onchange={apply} class="field" autocomplete="off" /></label>
		<label class="flex flex-col gap-1">Topic<input name="topic" value={data.q.topic ?? ''} onchange={apply} class="field" autocomplete="off" /></label>
		<label class="flex flex-col gap-1">Person<input name="person" value={data.q.person ?? ''} onchange={apply} class="field" autocomplete="off" /></label>
		<label class="flex flex-col gap-1">Written by key<input name="actor" value={data.q.actor ?? ''} onchange={apply} class="field" autocomplete="off" /></label>
		<label class="flex flex-col gap-1">Key kind
			<select name="said_by" onchange={apply} class="field">
				<option value="" selected={!data.q.said_by}>any</option>
				{#each TRUST_WORDS as w (w)}<option value={w} selected={data.q.said_by === w}>{w}</option>{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1">Trust at least
			<select name="min_trust" onchange={apply} class="field">
				<option value="" selected={!data.q.min_trust}>any</option>
				{#each TRUST_WORDS as w (w)}<option value={w} selected={data.q.min_trust === w}>{w}</option>{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1">Last N days<input name="days" type="number" min="1" max="365000" step="1" value={data.q.days ?? ''} onchange={apply} class="field" /></label>
		<div class="grid grid-cols-2 gap-3">
			<label class="flex flex-col gap-1">Order
				<select name="sort" onchange={apply} class="field">
					<option value="newest" selected={data.q.sort === 'newest'}>newest first</option>
					<option value="oldest" selected={data.q.sort === 'oldest'}>oldest first</option>
				</select>
			</label>
			<label class="flex flex-col gap-1">Per page
				<select name="limit" onchange={apply} class="field">
					{#each sizes as n (n)}<option value={n} selected={data.q.limit === n}>{n}</option>{/each}
				</select>
			</label>
		</div>
		<div class="flex items-end gap-3 sm:col-span-2 lg:col-span-4">
			<button type="submit" class="px-3 py-1.5 rounded bg-primary hover:bg-primary-light text-white">Apply</button>
			{#if filtered}<a href="{base}/thoughts" class="text-text-muted hover:text-text">Clear filters</a>{/if}
		</div>
	</form>

	<div class="bg-bg-card border border-white/10 rounded-xl p-5">
		{#if data.thoughts.length === 0}
			<p class="text-sm text-text-muted" data-testid="empty">{data.q.after ? 'No more thoughts.' : filtered ? 'No thought matches these filters.' : 'The brain holds no thoughts yet.'}</p>
		{:else}
			<!-- As the overview's: no preload (a thought's page is a logged `fetch`), and a full load (its page is the server's alone). -->
			<ul class="divide-y divide-white/5" data-testid="browse" data-sveltekit-preload-data="off" data-sveltekit-reload>
				{#each data.thoughts as t (t.id)}
					<li class="py-2 min-w-0">
						<a class="hover:text-primary-light [overflow-wrap:anywhere]" href="{base}/thoughts/{t.id}">{t.line}</a>
						<div class="text-xs text-text-muted [overflow-wrap:anywhere]">
							{t.created_at ? when(t.created_at) : 'undated'}{t.type ? ` · ${t.type}` : ''}{t.trust ? ` · ${t.trust}` : ''}{t.superseded ? ' · superseded' : ''}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
		{#if data.links.previous || data.links.next}
			<nav class="flex flex-wrap gap-4 pt-4 text-sm" aria-label="Pages" data-testid="pages">
				{#if data.links.first && data.links.first !== data.links.previous}<a href={data.links.first} class="text-text-muted hover:text-text" data-testid="first">First page</a>{/if}
				{#if data.links.previous}<a href={data.links.previous} rel="prev" class="text-text-muted hover:text-text" data-testid="previous">Previous</a>{/if}
				{#if data.links.next}<a href={data.links.next} rel="next" class="text-text-muted hover:text-text" data-testid="next">Next</a>{/if}
			</nav>
		{/if}
	</div>
</section>
