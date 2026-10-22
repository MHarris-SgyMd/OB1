<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	/** A row's label as a test id: `Schema version` → `schema-version`. */
	const testId = (label: string) => label.toLowerCase().replace(/\s+/g, '-');
</script>

<svelte:head><title>Status · Open Brain</title></svelte:head>

<section class="bg-bg-card border border-white/10 rounded-xl p-5">
	<h2 class="text-sm text-text-muted mb-3">This brain</h2>
	<dl class="grid grid-cols-[minmax(9rem,auto)_1fr] gap-x-6 gap-y-2 text-sm">
		{#each data.rows as [label, value] (label)}
			<dt class="text-text-muted">{label}</dt>
			<dd class="break-words" data-testid={testId(label)}>{value}</dd>
		{/each}
	</dl>
</section>
