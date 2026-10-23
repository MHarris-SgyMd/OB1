<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { HOME } from '$lib/paths';

	// A refusal the visitor can act on (rest.ts's words say how) is no fault of the GUI's.
	const refused = $derived(page.status === 400 || page.status === 403);
	// A browse page the core refused: its first page is the way back in (SMD-2280 PR 2a).
	const browse = $derived(refused && page.url.pathname === `${base}/thoughts`);
	// A search by meaning the embedding provider kept past the GUI's deadline (rest.ts's 504): the same query by exact
	// text, which needs no provider, one click away (review pass 3).
	const exact = $derived.by(() => {
		const q = page.url.searchParams.get('q');
		if (page.status !== 504 || page.url.pathname !== `${base}/search` || !q?.trim()) return null;
		return `${base}/search?${new URLSearchParams({ q, mode: 'text' })}`;
	});
</script>

<svelte:head><title>{page.status} · Open Brain</title></svelte:head>

<!-- Inside the layout, so the nav and sign-out stay; the message is the GUI's own (rest.ts), never the core's words. -->
<section class="bg-bg-card border border-white/10 rounded-xl p-5">
	<h1 class="text-xl font-semibold mb-2">{page.status === 404 ? 'Not found' : refused ? 'Refused' : 'Something went wrong'}</h1>
	<!-- SvelteKit's own words for a path no route serves are "Not Found", which the heading already says. -->
	<p class="text-sm text-text-muted" data-testid="error">{page.status === 404 && page.error?.message === 'Not Found' ? 'No page at this address.' : (page.error?.message ?? '')}</p>
	<p class="text-sm mt-4 flex flex-wrap gap-4">
		{#if browse}<a class="hover:text-primary-light" href="{base}/thoughts" data-testid="restart">Browse from the first page</a>{/if}
		{#if exact}<a class="hover:text-primary-light" href={exact} data-testid="exact">Search this by exact text</a>{/if}
		<a class="hover:text-primary-light" href={HOME}>Back to the overview</a>
	</p>
</section>
