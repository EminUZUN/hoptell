# Contributing

Thanks for helping. hoptell aims to stay small, so please keep that in mind.

## Principles

- **Keep it simple.** The relay should stay a single small process with no database. Prefer
  documenting a standard tool (VPN, TLS proxy, systemd) over building it in.
- **Security first.** Every message is text that another agent may act on. Changes that
  touch authentication, names or how messages reach an agent need a test.
- **Agent-neutral.** Features should work for any MCP-capable agent; agent-specific code
  belongs at the edges (`lib/tmux.js`, push detection in `lib/mcp.js`).

## Workflow

1. Open an issue first for larger changes, to agree on the approach.
2. `npm install && npm run lint && npm test` must pass. For changes to delivery (relay, MCP, tmux), also run
   the real-agent suite if you can: `npm run test:e2e -- --use-local-logins`. The suite starts its own relay on a random port
   and never touches your real settings. tmux tests run when tmux 3.2+ is installed.
3. Keep commits focused, and describe *why* in the message.
4. Update README.md and CHANGELOG.md when behavior or settings change.

## Releasing (maintainers)

First release setup:

1. Publish once by hand from a clean checkout: `npm publish --access public`.
2. For later automated npm releases, configure a trusted publisher in the package's
   npm settings: GitHub Actions, this repository, workflow `release.yml`, no environment.
   Create the configuration when preparing the first automated npm release: it must
   complete its first successful publish within two days. The tag for the manually
   published version skips npm, so it does not validate the configuration.
3. Tag that version as below. The workflow skips the npm version that is already
   published and publishes the relay image, the MCP Registry entry and the GitHub Release.
4. A new ghcr.io package is private. Make it public under the package's settings on
   GitHub, then check an anonymous pull: `docker logout ghcr.io && docker pull ghcr.io/eminuzun/hoptell`.

Every release:

1. For the first tag, keep the version already published to npm. For later releases,
   bump the version in `package.json`, `server.json` (both `version` and `packages[0].version`)
   and `.claude-plugin/plugin.json`. Update CHANGELOG.md. The release workflow refuses a tag
   that does not match all four.
2. `git tag -s vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`. The release workflow tests, then
   stages the npm version with `npm stage publish` (trusted publishing; no publishing
   secrets are configured in GitHub). Approve it with 2FA in the Staged Packages tab on
   npmjs.com, or use `npm stage list hoptell` and `npm stage approve <stage-id>`
   (npm 11.15+ and Node.js 22.14+). The workflow waits up to 30 minutes for the npm
   version to become public, then publishes the relay image, the MCP Registry entry and a
   GitHub Release using the corresponding CHANGELOG section.
3. If a run fails, re-run the job: it skips the npm version, image version, MCP Registry
   entry and GitHub Release when they already exist, and moves the image's `latest` tag
   only for npm's latest version. If the npm version is still staged, approve it first.
   Never move or reuse a published tag; fix forward with a new patch version.

## Layout

```
bin/hoptell.js   CLI entry point (relay, mcp, tmux, send, list, wait, listen)
lib/relay.js     WebSocket hub: auth, routing, queues, fan-out, rate limit
lib/client.js    relay client (heartbeat, reconnect, request/ack)
lib/mcp.js       MCP server: tools and push/inbox delivery
lib/inbox.js     per-user local inbox (one file per message)
lib/tmux.js      tmux launcher and message injector
lib/config.js    settings, names, state directory
```

## Conduct

Be respectful and constructive. Harassment or personal attacks are not tolerated in
issues, merge requests or any other project space.

By contributing you agree that your contributions are licensed under the Apache License 2.0.
