<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	/** A row's label as a test id: `Schema version` → `schema-version`. */
	const testId = (label: string) => label.toLowerCase().replace(/\s+/g, '-');
</script>

<svelte:head><title>Status · Open Brain</title></svelte:head>

<section class="bg-bg-card border border-white/10 rounded-xl p-5">
	<h1 class="text-sm text-text-muted mb-3">Status of this brain</h1>
	<dl class="grid grid-cols-1 sm:grid-cols-[minmax(9rem,auto)_1fr] gap-x-6 gap-y-1 sm:gap-y-2 text-sm">
		{#each data.rows as [label, value] (label)}
			<dt class="text-text-muted mt-2 sm:mt-0">{label}</dt>
			<dd class="min-w-0 [overflow-wrap:anywhere]" data-testid={testId(label)}>{value}</dd>
		{/each}
	</dl>
</section>
