<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Grants · Open Brain</title></svelte:head>

<section class="space-y-6">
	<header>
		<h1 class="text-xl font-semibold">Grants</h1>
		<p class="text-sm text-text-muted mt-1">
			Each client signed in as the operator through the authorization server holds a grant: the MCP clients you connected, and each sign-in to this dashboard. Revoking one refuses its refresh token at once; the access token it already holds is refused by the brain once it lapses, within ten minutes. Revoking one of this dashboard’s own grants ends that session at its next renewal.
		</p>
	</header>

	{#if data.notice === 'revoked'}
		<p class="text-sm text-green-300" role="status" data-testid="revoked">Revoked. Its access token is refused once it lapses, within ten minutes.</p>
	{:else if data.notice === 'gone'}
		<p class="text-sm text-text-muted" role="status" data-testid="gone">That grant was no longer there: revoked already, or lapsed.</p>
	{/if}
	{#if form?.error}
		<p class="text-sm text-amber-300" role="alert" data-testid="revoke-error">{form.error}</p>
	{/if}

	{#if data.state === 'unreachable'}
		<p class="text-sm text-amber-300" role="alert" data-testid="unreachable">The authorization server did not answer, so its grants cannot be shown. Start it again on the brain’s machine (<code>compose up -d --wait auth</code>, with the stack’s other files); a server built before this page has no listener for it, and is rebuilt with <code>compose up -d --build --wait auth</code>.</p>
	{:else if data.state === 'locked'}
		<p class="text-sm text-amber-300" role="alert" data-testid="locked">The authorization server is turning the dashboard away for now, after refusing its credentials too often: <code>OB1_AUTH_SECRET_GUI</code> in <code>deploy/.env</code> may not match the server’s. Set it and recreate <code>auth</code> and <code>app</code>; otherwise the server takes the dashboard again within 15 minutes.</p>
	{:else if data.state === 'refused'}
		<p class="text-sm text-amber-300" role="alert" data-testid="refused">The authorization server refused the dashboard’s credentials. <code>OB1_AUTH_SECRET_GUI</code> in <code>deploy/.env</code> may not match the server’s; recreate <code>auth</code> and <code>app</code>.</p>
	{:else if data.grants.length === 0}
		<p class="text-sm text-text-muted" data-testid="no-grants">No grants: no client is signed in as the operator.</p>
	{:else}
		<ol class="space-y-3" data-testid="grants">
			{#each data.grants as g (g.id)}
				<li class="bg-bg-card border border-white/10 rounded-xl p-5 text-sm flex flex-wrap gap-4 justify-between min-w-0" data-testid="grant" data-grant={g.id}>
					<div class="space-y-1 min-w-0">
						<div class="font-medium [overflow-wrap:anywhere]">{g.label}</div>
						{#if g.detail}<div class="text-xs text-text-muted font-mono [overflow-wrap:anywhere]" data-testid="client">{g.detail}</div>{/if}
						<div class="text-xs text-text-muted [overflow-wrap:anywhere]">{g.scope || 'no scope'}{#if g.resources.length}{' · '}for {g.resources.join(', ')}{/if}</div>
						<div class="text-xs text-text-muted">Signed in {g.created}{#if g.renewed}{' · '}last renewed {g.renewed}{/if}{' · '}lapses {g.lapses}</div>
					</div>
					<form method="POST" action="?/revoke" class="self-center">
						<input type="hidden" name="grant" value={g.id} />
						<button type="submit" class="button">Revoke</button>
					</form>
				</li>
			{/each}
		</ol>
		{#if data.more}
			<p class="text-sm text-text-muted" data-testid="more">The newest 500 shown; older grants lapse on their own within 30 days.</p>
		{/if}
	{/if}
</section>
