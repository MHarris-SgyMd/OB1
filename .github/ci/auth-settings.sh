#!/usr/bin/env bash
# deploy/.env configured for the authorization server, as a stack that runs it
# is (SMD-3051): the four settings that configure it, COMPOSE_PROFILES=auth
# among them (the server refuses to start configured without it, SMD-1846 PR 2),
# the secrets `auth/provision.ts --init` writes, and provision.ts's check of the
# file. The cap of 3 clients and the trusted proxy are the authorization
# server step's own settings, which it tests.
#
# The full-stack auth job's authorization server step runs this before it
# starts the server. The other two full-stack jobs run it where that step ran
# when the three were one job, and recreate the MCP server on it, so the steps
# after it meet what they met then: a server configured for an origin whose
# authorization server is not running, and a deploy/.env holding OB1_AUTH_
# lines, which canary.sh must leave out of the canary's file.
#
# CI only: it appends a made-up origin, the auth profile and fresh secrets to
# deploy/.env, which on an operator's checkout is the brain's own file, so it
# refuses outside Actions (no GITHUB_ENV), as full-stack-up.sh does. Under
# bash -e -o pipefail, the workflow's default shell.
set -eo pipefail
: "${GITHUB_ENV:?GITHUB_ENV is not set: this runs as a GitHub Actions step, and appends to deploy/.env}"
cd "$(dirname "$0")/../../deploy"
printf 'OB1_PUBLIC_ORIGIN=https://brain.example.test\nOB1_AUTH_MAX_CLIENTS=3\nCOMPOSE_PROFILES=auth\nOB1_AUTH_TRUSTED_PROXY=127.0.0.1\n' >> .env
bun auth/provision.ts --init
bun auth/provision.ts
