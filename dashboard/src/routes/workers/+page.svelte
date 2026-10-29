<script lang="ts">
	import { when } from '$lib/format';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const n = (v: number) => v.toLocaleString();
	/** Whether a pool's row has anything this session may act on (SMD-3322 PR 3). */
	const actable = (p: { failed: number; stale: number }) => (data.canRetry && p.failed > 0) || (data.canRelease && p.stale > 0);
	const acting = $derived(data.pools.some(actable));
</script>

<svelte:head><title>Workers · Open Brain</title></svelte:head>

<section class="space-y-6">
	<h1 class="text-xl font-semibold">Workers</h1>
	{#if form && 'done' in form}
		<p class="text-sm" role="status" data-testid="worker-done">{form.done}</p>
	{:else if form && 'error' in form}
		<p class="text-sm text-amber-300" role="alert" data-testid="worker-error">{form.error}</p>
	{/if}
	<div class="bg-bg-card border border-white/10 rounded-xl p-5 space-y-3">
		{#if data.pools.length === 0}
			<p class="text-sm text-text-muted" data-testid="empty">No work has been queued: a pool appears once anything is queued for it.</p>
		{:else}
			<p class="text-sm text-text-muted">
				Each pool counts its claims on the brain's {n(data.pools[0].thoughts)} thoughts. In flight includes stale leases — a stopped worker's, which the next run reclaims.
			</p>
			<!-- A table that scrolls on its own on a phone, not the page, and a region a keyboard can reach to scroll it: a
			     scrolling region with no focus is axe's scrollable-region-focusable (review pass 1). -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="overflow-x-auto" tabindex="0" role="region" aria-label="Pools">
				<table class="w-full text-sm" data-testid="pools">
					<thead class="text-text-muted text-left">
						<tr>
							<th scope="col" class="py-1 pr-4 font-normal">Pool</th>
							<th scope="col" class="py-1 pr-4 font-normal text-right">Not queued</th>
							<th scope="col" class="py-1 pr-4 font-normal text-right">Waiting</th>
							<th scope="col" class="py-1 pr-4 font-normal text-right">In flight</th>
							<th scope="col" class="py-1 pr-4 font-normal text-right">Stale</th>
							<th scope="col" class="py-1 pr-4 font-normal text-right">Done</th>
							<th scope="col" class="py-1 font-normal text-right">Failed</th>
							{#if acting}<th scope="col" class="py-1 pl-4 font-normal text-left">Act</th>{/if}
						</tr>
					</thead>
					<tbody class="divide-y divide-white/5">
						<!-- By row: two pool names alike once on one line and cut would be one key, and Svelte refuses that (review pass 1). -->
						{#each data.pools as p, i (i)}
							<tr>
								<th scope="row" class="py-1 pr-4 font-normal font-mono text-left [overflow-wrap:anywhere]">
									{p.workType}{#if p.active === true}{' '}<span class="ml-2 text-xs text-text-muted font-sans">active</span>{:else if p.active === false}{' '}<span class="ml-2 text-xs text-text-muted font-sans">not the active pool</span>{/if}
								</th>
								<td class="py-1 pr-4 text-right">{n(p.unpooled)}</td>
								<td class="py-1 pr-4 text-right">{n(p.pending)}</td>
								<td class="py-1 pr-4 text-right">{n(p.claimed)}</td>
								<td class="py-1 pr-4 text-right {p.stale ? 'text-amber-300' : ''}">{n(p.stale)}</td>
								<td class="py-1 pr-4 text-right">{n(p.succeeded)}</td>
								<td class="py-1 text-right {p.failed ? 'text-amber-300' : ''}">{n(p.failed)}</td>
								{#if acting}
									<!-- Each pool's own forms, its name whole in them as the core wrote it (the cell shows it cut). -->
									<td class="py-1 pl-4">
										<div class="flex flex-wrap gap-2">
											{#if data.canRetry && p.failed > 0}
												<form method="POST" action="?/retry" data-testid="retry">
													<input type="hidden" name="work_type" value={p.key} />
													<button type="submit" class="button text-xs">Retry {n(p.failed)} failed</button>
												</form>
											{/if}
											{#if data.canRelease && p.stale > 0}
												<form method="POST" action="?/release" data-testid="release">
													<input type="hidden" name="work_type" value={p.key} />
													<button type="submit" class="button text-xs">Release {n(p.stale)} stale</button>
												</form>
											{/if}
										</div>
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#each data.pools.filter((p) => p.stale > 0) as p, i (i)}
				<p class="text-sm text-amber-300 [overflow-wrap:anywhere]" data-testid="stale">
					{p.workType}: {n(p.stale)} stale lease{p.stale === 1 ? '' : 's'}, the oldest claimed {when(p.oldestStaleClaimedAt)}{p.staleWorkerId ? ` by ${p.staleWorkerId}` : ''}.
				</p>
			{/each}
		{/if}
	</div>
</section>
