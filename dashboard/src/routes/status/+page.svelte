<script lang="ts">
	import { bytes, when } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const info = $derived(data.info);
	const db = $derived('error' in info.database ? null : info.database);
	const dbError = $derived('error' in info.database ? info.database.error : null);
	const range = (r: readonly [number, number] | null) => (r ? `${r[0]}–${r[1]}` : '—');
	const ago = (s: number) => (s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
</script>

<svelte:head><title>Status · Open Brain</title></svelte:head>

<section class="space-y-6">
	<div class="bg-bg-card border border-white/10 rounded-xl p-5">
		<h2 class="text-sm text-text-muted mb-3">Server</h2>
		<dl class="grid grid-cols-[minmax(10rem,auto)_1fr] gap-x-6 gap-y-2 text-sm">
			<dt class="text-text-muted">Version</dt><dd data-testid="version">{info.version}</dd>
			<dt class="text-text-muted">Commit</dt><dd class="font-mono">{info.commit}</dd>
			<dt class="text-text-muted">Release's migrations</dt><dd>{range(info.releaseRange)}</dd>
			<dt class="text-text-muted">Unreleased migrations</dt><dd>{range(info.unreleased)}</dd>
			<dt class="text-text-muted">Latest migration in its tree</dt><dd>{info.latestMigration}</dd>
			<dt class="text-text-muted">Store</dt><dd>{info.store}</dd>
			<dt class="text-text-muted">Embedding</dt><dd>{info.embedding.model} · {info.embedding.dim} dimensions</dd>
		</dl>
	</div>

	<div class="bg-bg-card border border-white/10 rounded-xl p-5">
		<h2 class="text-sm text-text-muted mb-3">Database</h2>
		{#if dbError}
			<p class="text-sm text-red-400" role="alert">The database did not answer: {dbError}</p>
		{:else if db}
			<dl class="grid grid-cols-[minmax(10rem,auto)_1fr] gap-x-6 gap-y-2 text-sm">
				<dt class="text-text-muted">Ledger</dt>
				<dd data-testid="ledger">
					{db.highestMigration ?? '—'}{info.ledgerStatus ? ` · ${info.ledgerStatus}` : ''}
				</dd>
				<dt class="text-text-muted">Schema version</dt><dd>{db.schemaVersion ?? '—'}</dd>
				<dt class="text-text-muted">Postgres</dt><dd>{db.postgres}</dd>
				<dt class="text-text-muted">pgvector</dt><dd>{db.pgvector ? `${db.pgvector.version} (schema ${db.pgvector.schema})` : 'not installed'}</dd>
				<dt class="text-text-muted">Recorded embedding</dt><dd>{db.embedding.model ?? '—'} · {db.embedding.dim ?? '—'}</dd>
				<dt class="text-text-muted">Size</dt><dd>{bytes(db.databaseBytes)}</dd>
				{#if db.counts}
					{#each Object.entries(db.counts) as [table, n] (table)}
						<dt class="text-text-muted">{table}</dt><dd>{n === null ? '—' : n.toLocaleString()} rows</dd>
					{/each}
				{/if}
				<dt class="text-text-muted">Without a vector</dt><dd>{db.vectorless ?? '—'}</dd>
				<dt class="text-text-muted">Proposals pending</dt>
				<dd>{db.proposals ? `${db.proposals.pending} (${db.proposals.stale} stale)` : '—'}</dd>
				<dt class="text-text-muted">Board synced to</dt><dd>{when(db.boardSync)}</dd>
			</dl>
			{#if Object.keys(db.unread).length > 0}
				<h3 class="text-sm text-text-muted mt-5 mb-2">Not read</h3>
				<ul class="text-sm space-y-1">
					{#each Object.entries(db.unread) as [field, why] (field)}
						<li><span class="font-mono">{field}</span>: {why.reason} — {why.message}</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>

	{#if db?.workers}
		<div class="bg-bg-card border border-white/10 rounded-xl p-5">
			<h2 class="text-sm text-text-muted mb-3">Workers' heartbeats</h2>
			{#if db.workers.heartbeats.length === 0}
				<p class="text-sm text-text-muted">No worker has run on this brain.</p>
			{:else}
				<table class="w-full text-sm">
					<thead class="text-text-muted text-left">
						<tr><th class="py-1">Worker</th><th>Job</th><th>Last stamp</th><th>State</th><th>Last pass</th></tr>
					</thead>
					<tbody>
						{#each db.workers.heartbeats as h (h.key)}
							<tr class="border-t border-white/5">
								<td class="py-1">{h.worker}</td>
								<td class="font-mono">{h.job ?? '—'}</td>
								<td>{ago(h.ageS)} ago</td>
								<td class={h.stale && !h.ended ? 'text-red-400' : ''}>{h.ended ? 'ended' : h.stale ? 'stale' : h.running ? 'running' : 'idle'}</td>
								<td>{h.outcome ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	{/if}
</section>
