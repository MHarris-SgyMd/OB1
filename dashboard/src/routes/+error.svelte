<script lang="ts">
	import { page } from '$app/state';
	import { HOME } from '$lib/paths';
</script>

<svelte:head><title>{page.status} · Open Brain</title></svelte:head>

<!-- Inside the layout, so the nav and sign-out stay; the message is the GUI's own (rest.ts), never the core's words. -->
<section class="bg-bg-card border border-white/10 rounded-xl p-5">
	<h1 class="text-xl font-semibold mb-2">{page.status === 404 ? 'Not found' : 'Something went wrong'}</h1>
	<!-- SvelteKit's own words for a path no route serves are "Not Found", which the heading already says. -->
	<p class="text-sm text-text-muted" data-testid="error">{page.status === 404 && page.error?.message === 'Not Found' ? 'No page at this address.' : (page.error?.message ?? '')}</p>
	<p class="text-sm mt-4"><a class="hover:text-primary-light" href={HOME}>Back to the overview</a></p>
</section>
