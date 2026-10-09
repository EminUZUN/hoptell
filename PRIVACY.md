# Privacy policy

Effective: 7 October 2026

hoptell is open-source software that you run yourself. This policy describes what the
software does with data. It covers the hoptell npm package, the Claude Code plugin and the
relay container image.

## Who handles your data

hoptell has no built-in telemetry, analytics or crash reporting, and does not automatically
send installation or usage data to the hoptell project or its author. You choose the relay
operator (you or your organization), who controls the relay's configuration and logs. If you
contact the maintainers through GitHub issues or security reports, they receive the
information you choose to submit.

Installation may contact your configured package registry or GitHub's repository and
container services. Those services handle installation requests under their own policies:
[npm privacy information](https://docs.npmjs.com/policies/privacy/) and
[GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
Other registries have their own policies.

## What hoptell processes

- Message text, sender and recipient peer names, timestamps and message ids.
- Peer metadata: peer name, roles, the machine's sanitized host name, the connection's IP
  address and online status.
- Shared or per-member authentication tokens, configured member names, and relay and client
  settings.

hoptell uses this data to authenticate clients, discover peers, route messages and confirm
receipt. Authenticated clients can list other known peers' names, roles, host labels, online
status and queued-message counts. Message text is routed to the addressed peers. Unless
`HOPTELL_PUSH` chooses `channel`, `tmux` or `listener`, the MCP server also reads, locally, the
IDs, user IDs, start times and command lines of the processes that started it, and the boot
identifier, to find the Claude Code process and check its channel flags. The hoptell hook
commands, whenever Claude Code runs them, read the same information to find their Claude Code
process. None of this is sent to the relay.

## The relay

- Messages travel to and from the relay over WebSocket. The relay has no built-in TLS, so
  run it on a private network or VPN, or behind a TLS proxy (`wss://`).
- The relay holds queued messages, deliveries awaiting confirmation and peer metadata in
  process memory; it does not persist that state to disk. New queue admissions are limited to
  50 messages per peer and 2,000 overall, with up to 50 additional deliveries awaiting
  confirmation per peer. Requeueing previously accepted, unconfirmed deliveries can exceed the
  normal queue limits.
- The relay's state directory holds a random realm id and, while the relay runs, a lock file
  with its process id. An optional realm name comes from the relay's configuration and is
  sent to clients. It holds no messages, names or tokens.
  Name leases and reservations (which session holds a name, for up to 30 seconds after its
  connection drops) are kept in memory only.
- For receivers on the current protocol, each delivered message also states how the sender
  was authenticated: the sender's member id and member name, or that a shared token was used,
  and the relay's realm id.
- `hoptell members add` stores a new member's token as its SHA-256 in the members file and
  shows the token once. The members file is not encrypted by hoptell.
- With sign-in through an identity provider (configured by the operator with `--oidc`), the
  members file also holds each linked identity: the provider's issuer URL and the account's
  subject identifier. The relay fetches the provider's public keys and, with introspection,
  sends each access token to that provider only, authenticated with the relay's client secret
  (read from a file the operator names). Access tokens are kept in memory while needed for
  rechecks and are not written to disk or logs; the relay records the signed-in subject and
  groups in memory for the connection. Refused sign-ins are logged with the reason and the
  client address; an identity that is not linked is logged with its issuer and, when
  fingerprint logging is enabled, a keyed tag of its subject. `/.well-known/hoptell` publishes
  the realm id, the issuers and the public CLI client settings, no secrets.
- In broker mode (an issuer with `"mode": "broker"`), the relay signs users in at the provider
  itself, with its client credential from a file the operator names, and validates the ID token.
  It does not keep the provider's tokens. In `<state dir>/broker/` (0700/0600, not encrypted by
  hoptell) it keeps a 32-byte key for its refresh tokens and, per sign-in, the member id, issuer,
  subject, provider client id, times (created, last used, expiry, re-verification) and the
  SHA-256 of the current refresh token; ended sign-ins are kept 30 days for diagnostics.
  Sign-ins in progress, one-time codes and access tokens are in memory only. The page shown to a
  user whose identity is not linked names the issuer and subject.
- The relay stops retaining a message when the receiving client confirms receipt. This
  confirms local storage or output, not that an agent read or acted on it. Restarting the
  relay discards its message and peer state. On relays supporting expiry, the sender can set a
  time-to-live (TTL). Expired queued messages are removed before forwarding or during periodic
  cleanup (every 15 seconds by default). Messages without a TTL have no scheduled expiry. This does not
  remove copies already delivered to a local inbox. Periodic cleanup removes a peer only when
  it is offline, has no queued messages and was last seen more than six hours ago.
- The relay's default logger writes timestamps, connection and routing metadata,
  authentication failures, and socket or internal error descriptions to standard output.
  Metadata includes peer names, roles, host labels, IP addresses, message references (random
  ids) and delivery stages, and, for some routing events, message lengths in characters.
  Logging calls do not explicitly include message text, file contents, file labels, snapshot
  digests or authentication-token fields. Content-derived keyed fingerprints are added only
  when the operator enables fingerprint logging, as described below. The operator controls
  where output is stored and how long it is kept. When the operator configures trusted proxies,
  log lines also show the client address forwarded by those proxies.
- The optional metrics endpoint is disabled by default. When enabled, it exposes
  aggregate counts, sizes and ages, including connected peers, queued messages,
  queued bytes and delivery attempts. It binds to 127.0.0.1 unless the operator
  configures another address. It contains no peer names, message text or tokens,
  but it reveals activity levels.
- Fingerprint logging is disabled by default. When enabled, the relay reads a private key file
  on its own machine and computes HMAC-SHA-256 tags from decoded message text, a public key id
  and the relay-assigned message reference. The public id and tags appear in message-routing
  and delivery-event logs; the key does not. The relay does not send the key or tags to
  clients. A message reference serves as a nonce, so separately accepted messages do not have
  a stable content tag. Anyone with the key can test candidate message text, and existing log
  metadata can identify participants. The operator controls key storage, access to logs,
  retention and any retained older keys. hoptell does not encrypt the key file, make logs
  tamper-proof or automatically delete retained logs. Fingerprints do not establish which file
  version an agent reviewed.

## Each machine

- The MCP server stores incoming messages as local JSON files before confirming receipt. With a
  current relay, the inbox is in the session's folder
  `~/.hoptell/v2/<realm id>/<member id or "shared">/<session>/inbox/`; with earlier relays it is
  `~/.hoptell/inbox/<peer name>/` (both under `$HOPTELL_HOME` when configured). The session
  folder also holds `binding.json` (realm id, member id, session name and creation time) and
  `seen/`, with one empty file per received delivery id, used to avoid storing a redelivered
  message twice. Delivery ids older than eight days are removed when an agent session opens
  the folder; message files follow the inbox rules below. Message file names include the
  delivery id. With receipts, the folder also holds `store.json` (format version, receipt policy,
  a counter), `claimed/` (batches handed to an agent or `hoptell listen`, with the consumer's
  process id, start time and boot id and the lease deadline) and `done/` (the receipts of up to
  256 acknowledged batches from the last 24 hours, with the consumer and time). A message file that is not valid JSON is moved to `damaged/`
  and kept for inspection. `quarantine/` and `decisions/` are created empty for later use. For sessions with an explicit
  `HOPTELL_NAME`, `~/.hoptell/v2/<realm id>/names/<name>.json` records which member's folder
  holds that name, so the tmux injector and `hoptell listen <name>` read the right inbox. hoptell creates directories with Unix
  mode 0700 and files with mode 0600; access is subject to the operating system, including
  administrator privileges.
- Message files are consumed and deleted by `read_inbox`, `wait_for_message`, or
  `hoptell listen`. Consumption does not confirm that an agent processed the message. The tmux
  injector and the hoptell hooks only announce waiting messages with a fixed notice; they do
  not read or delete message files. Pending files have no automatic expiry. The standalone
  `hoptell wait` command prints received messages directly to standard output instead of
  storing them in the inbox.
- Contacts (who may reach your sessions) are kept in `~/.hoptell/contacts.json` (your policy:
  grants and blocks naming relay realm ids, member ids or shared-token sender names) and
  `~/.hoptell/contacts/` (the mode marker with drop counters and notification times; one record
  per sender waiting for your decision, with the sender's label and identity as the relay stated
  it, the receiving sessions and message sizes and times; decisions in progress; and the last 100
  finished requests). Held messages themselves are kept in each session folder's `quarantine/`
  (or `~/.hoptell/legacy/<name>/` for sessions on earlier relays) until you release or block them,
  or for seven days. Desktop notifications show the sender label and session name, never message
  text. All of these are under `$HOPTELL_HOME` when configured, private (0700/0600), and not
  encrypted by hoptell.
- `hoptell login` signs in with the identity provider named by the relay; the provider handles
  your account and password (in your browser) under its own policies. The stored credential is
  a refresh token (or, for a service account, its client secret) with the relay URL, realm id,
  issuer and client id it belongs to. It is kept in the operating system's keychain (macOS
  Keychain, Linux Secret Service), or with `--store file` in `~/.hoptell/credentials/` encrypted
  with AES-256-GCM under a key derived from `HOPTELL_CREDENTIAL_PASSPHRASE`. `~/.hoptell/credentials/`
  also holds, per relay profile, an unencrypted index with that relay URL, realm id, issuer,
  client id and the home folder path (no token), and lock files. Access tokens are kept in
  memory only. `hoptell logout` deletes the credential and asks the provider to revoke it. In
  broker mode the stored credential is the relay's own refresh token (not the provider's), with
  a mark while a renewal is in flight; `hoptell logout` asks the relay to end it.
- With several relays (a relays file), `~/.hoptell/routes.json` records, for messages read in the
  last seven days (at most 10,000), which relay profile and realm each message reference came
  from, so replies go through the same relay; it holds no message text or names.
  `~/.hoptell/sessions/<name>.stores.json` lists the storage folders a session reads (for the tmux
  notice), and is removed when the session ends. Sessions on earlier relays keep their files under
  `~/.hoptell/links/<relay profile>/` and `~/.hoptell/legacy/<relay profile>/`.
- `hoptell local-relay` keeps its relay in `~/.hoptell/local-relay/`: the member token (0600),
  the members file with its SHA-256, the realm state and its settings file. The relay's log, with
  the metadata described under "The relay", goes to `relay.log` there (macOS) or to your user
  journal (Linux); neither is removed automatically. The service definition is in
  `~/Library/LaunchAgents/` (macOS) or `~/.config/systemd/user/` (Linux) and contains paths, not
  the token. `uninstall --purge` removes all of it.
- `hoptell mcp-http` keeps its clients in `~/.hoptell/mcp-http/clients.json` (0600): each
  client's label, peer name, roles, creation time and the SHA-256 of its token (the token itself is
  shown once and not stored). The SessionStart hook's record in `~/.hoptell/wake/` also holds a
  random registration id that `hoptell hook-header` prints for an HTTP client; it names no message,
  sender or token.
- Relay profiles in `~/.hoptell/profiles/` record, per configured relay, its realm id, whether
  it requires the current protocol, the member id it reported and the time of the last change.
  They are named after a hash of the relay URL (or `HOPTELL_PROFILE`) and contain no URL or
  token. They let hoptell notice when a relay URL starts answering with another realm.
- Hook delivery (Claude Code) uses private files in `~/.hoptell/wake/` (under `$HOPTELL_HOME`
  when configured), created with Unix mode 0700 and 0600. They hold process identifiers and
  start times of the Claude Code process and the MCP server, the Claude Code session id, the
  peer name, random values and counters. They hold no message text, sender, relay URL, token,
  prompt or transcript. On a handled shutdown, the MCP server removes its runtime record and
  notice claims. Ownership state is retained for later ended-host cleanup. Later SessionStart hooks attempt bounded cleanup of
  ended hosts whose registration is old; deletion by a fixed deadline is not guaranteed.
- `hoptell tmux` writes any configured relay URL, token, delivery setting and approved
  snapshot folder settings to
  `~/.hoptell/sessions/<name>.env` (under `$HOPTELL_HOME` when configured). The file is not
  encrypted by hoptell and is created with Unix mode 0600 in private directories. It remains
  after the session ends, until you delete it or launch another session with the same name.
- The plugin's sensitive relay-token setting is stored in Claude Code's secure credential
  storage. Other settings may be stored differently by Claude Code. hoptell also reads
  environment variables and the first applicable settings file: `HOPTELL_ENV` if specified;
  otherwise `$XDG_CONFIG_HOME/hoptell/.env` (default `~/.config/hoptell/.env`) or the
  package's `.env`. Non-empty environment variables take precedence. Tokens in these files are
  not encrypted by hoptell.

`hoptell snapshot` loads its settings as described above and reads the selected file with the
operating-system permissions of the process running it. `hoptell snapshot <file>` prints a JSON
envelope containing the supplied file path, byte count, request id, SHA-256 and content.
`--check` prints a comparison result and does not print file content. These commands do not
save a snapshot or send it to the relay; the caller decides whether to send the output.

The MCP server's file tools are disabled by default. When you configure approved local folders,
send_file can read a selected regular UTF-8 file from those folders and send its captured
content, a relative file label, byte count, SHA-256 digest, review request id and review request
to one named peer through your configured relay. The receiving agent's AI provider may process
that content. Folder configuration does not make another agent's request an authorization to
share a file.

Outgoing snapshot records contain local file labels, hashes, sizes, request ids, recipient and
delivery metadata, but not file contents, request prose or credentials. They are stored under
HOPTELL_HOME/snapshots or ~/.hoptell/snapshots in user-owned directories with mode 0700 and
files with mode 0600 on supported macOS/Linux systems. Records expire after 24 hours and are
cleaned up while the MCP server is running. Each MCP server instance accepts at most 256 live
records of up to 8192 bytes each; multiple instances use additional storage. These records are
not encrypted, and backups may retain them. Stored labels and digests are themselves metadata,
and a digest can be compared against guessed file contents.

The receiver's normal inbox can still contain the complete snapshot message, including file
contents, under the existing inbox retention rules. Agent sessions, terminal output and AI
providers can retain data separately. The standalone snapshot CLI prints a snapshot locally and
does not create outgoing records or send it automatically.

The MCP server writes connection and error information to standard error. CLI output, tmux
terminal content, and the agent's own conversations or logs may retain messages independently
of the inbox.

## AI providers

The hoptell relay and MCP server do not directly call AI services. When message text or peer
metadata is supplied to an agent, the agent may include it in conversation context sent to its
configured AI provider. Processing and retention depend on the agent, provider, account and
settings. The receiving agent may use a different provider from yours. Do not send a peer
anything you would not share with its operator and its configured provider.

Privacy policies and data-handling information for common providers:

- Anthropic: [Privacy Policy](https://www.anthropic.com/legal/privacy); for applicable
  business services, [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and
  [Data Processing Addendum](https://www.anthropic.com/legal/data-processing-addendum).
- OpenAI: [Privacy Policy](https://openai.com/policies/privacy-policy/);
  [business and API data privacy information](https://openai.com/business-data/).
- Google: <https://policies.google.com/privacy>

The applicable policies and agreements depend on the services and accounts you use. Consult
the policies for any other providers or services you configure.

## Deleting data

- Relay: stop or restart it to discard in-memory messages and peer state. Remove retained logs
  separately according to your setup.
- Each machine: stop the relevant hoptell processes, then delete `~/.hoptell` or the
  configured `$HOPTELL_HOME` directory to remove local inbox and session files. Remove stored
  tokens from the settings sources you used.

These steps do not remove copies retained by other peers, agents, AI providers, terminal
output, logs or backups.

## Children

hoptell is a developer tool and is not intended for people under 18.

## Changes

Changes to this policy are published in this file, and its Git history shows earlier
versions.

## Contact

Open an issue at <https://github.com/EminUZUN/hoptell/issues>. Report security issues
privately as described in [SECURITY.md](SECURITY.md).
