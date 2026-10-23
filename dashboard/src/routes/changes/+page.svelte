<script lang="ts">
	import { base } from '$app/paths';
	import { when } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const VERB = { capture: 'captured', update: 'edited', delete: 'deleted' } as const;
	/** What an edit moved, as the core names its fields; the keys of metadata beside it. */
	const moved = (c: PageData['changes'][number]) =>
		c.changed.map((f) => (f === 'metadata' && c.metadataKeys.length ? `metadata (${c.metadataKeys.join(', ')})` : f)).join(', ');
</script>

<svelte:head><title>Changes · Open Brain</title></svelte:head>

<section class="space-y-6">
	<h1 class="text-xl font-semibold">Changes</h1>

	<!-- A GET form, applied by Enter or the button: a new filter starts again from the newest (no cursor rides it). -->
	<form method="GET" action="{base}/changes" class="bg-bg-card border border-white/10 rounded-xl p-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm items-end" data-testid="filters" data-sveltekit-keepfocus data-sveltekit-noscroll>
		<label class="flex flex-col gap-1">Since<input name="since" value={data.q.since ?? ''} class="field" placeholder="2026-10-23 or 2026-10-23T08:00:00Z" autocomplete="off" /></label>
		<label class="flex flex-col gap-1">Written by key<input name="agent" value={data.q.agent ?? ''} class="field" autocomplete="off" /></label>
		<fieldset class="flex flex-wrap gap-x-4 gap-y-1 items-center">
			<legend class="mb-1">Kinds</legend>
			{#each ['capture', 'update', 'delete'] as a (a)}
				<label class="flex items-center gap-1"><input type="checkbox" name="action" value={a} checked={data.q.actions.includes(a as 'capture')} />{a}</label>
			{/each}
		</fieldset>
		<label class="flex items-center gap-2"><input type="checkbox" name="others_only" value="1" checked={data.q.others_only} />Leave out this key's own</label>
		<label class="flex flex-col gap-1">Per page<input name="limit" type="number" min="1" max="200" step="1" value={data.q.limit} class="field" /></label>
		<div class="flex items-end gap-3 sm:col-span-2 lg:col-span-3">
			<button type="submit" class="button">Apply</button>
			{#if data.newest}<a href={data.newest} class="text-text-muted hover:text-text" data-testid="newest">The newest changes</a>{/if}
		</div>
	</form>

	<div class="bg-bg-card border border-white/10 rounded-xl p-5 space-y-3">
		<p class="text-sm text-text-muted">
			{data.bounded ? 'From the start given, oldest first.' : `The ${data.changes.length} most recent, oldest first.`}
		</p>
		{#if data.changes.length === 0}
			<p class="text-sm text-text-muted" data-testid="empty">No change{data.q.since ? ' after that start' : ' recorded yet'}.</p>
		{:else}
			<!-- As the other lists': no preload (a thought's page is a logged `fetch`), and a full load. -->
			<ol class="divide-y divide-white/5" data-testid="changes" data-sveltekit-preload-data="off" data-sveltekit-reload>
				{#each data.changes as c (c.id)}
					<li class="py-2 min-w-0 text-sm space-y-0.5" data-change={c.id}>
						<div class="[overflow-wrap:anywhere]">
							<span class="text-text-muted">{when(c.at)}</span> — {VERB[c.action]} by {c.who ?? 'a key not recorded'}{c.kind ? ` (${c.kind})` : ''} —
							{#if c.present}<a class="hover:text-primary-light font-mono" href="{base}/thoughts/{c.thoughtId}">{c.thoughtId}</a>{:else}<span class="font-mono">{c.thoughtId}</span>{c.action === 'delete' ? '' : ' (deleted since)'}{/if}
						</div>
						{#if c.text !== null}<div class="text-text-muted [overflow-wrap:anywhere]">{c.action === 'delete' ? 'was' : c.action === 'capture' ? 'now' : 'text'}: “{c.text}”</div>{/if}
						{#if c.action === 'update' && c.changed.length}<div class="text-text-muted [overflow-wrap:anywhere]">changed: {moved(c)}</div>{/if}
						{#if c.supersedesAfter}<div class="text-text-muted font-mono [overflow-wrap:anywhere]">supersedes {c.supersedesAfter}{c.supersedesBefore && c.supersedesBefore !== c.supersedesAfter ? ` (was ${c.supersedesBefore})` : ''}</div>
						{:else if c.supersedesBefore}<div class="text-text-muted font-mono [overflow-wrap:anywhere]">{c.action === 'delete' ? 'it superseded' : 'no longer supersedes'} {c.supersedesBefore}</div>{/if}
						{#if c.derivation}<div class="text-text-muted">{c.action === 'capture' ? 'captured with sources (derived_from)' : 'sources (derived_from) changed'}</div>{/if}
					</li>
				{/each}
			</ol>
		{/if}
		{#if data.next}
			<nav class="text-sm pt-2" aria-label="Pages" data-testid="pages"><a href={data.next} rel="next" class="text-text-muted hover:text-text" data-testid="next">Next</a></nav>
		{:else if data.more && !data.bounded}
			<p class="text-sm text-text-muted" data-testid="older">Older changes exist: set Since to a time before the first change above to read them.</p>
		{/if}
	</div>
</section>
