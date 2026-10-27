# Privacy policy

Effective: 14 October 2026

hoptell is open-source software that you run yourself. This policy describes what the
software does with data. It covers the hoptell npm package, the Claude Code plugin and the
relay container image.

## Who handles your data

hoptell has no built-in telemetry, analytics or crash reporting, and does not automatically
send installation or usage data to the hoptell project or its author. You choose the relay
operator (you or your organization), who controls the relay's configuration and logs. If you
contact the maintainers through GitHub issues or security reports, they receive the
information you choose to submit.

With hosted MCP endpoints (experimental, `hoptell mcp-hosted --experimental`), a relay operator
holds some members' sessions for them ("hosted custody"): the host reads and stores those
members' messages. Messages to a hosted member are never end-to-end encrypted, and its peers see
it labeled as hosted.

Installation may contact your configured package registry or GitHub's repository and
container services. Those services handle installation requests under their own policies:
[npm privacy information](https://docs.npmjs.com/policies/privacy/) and
[GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
Other registries have their own policies.

## What hoptell processes

- Message text, sender and recipient peer names, timestamps and message ids.
- Peer metadata: peer name, roles, the machine's sanitized host name, the connection's IP
  address and online status, and the session's title when one is set.
- Shared or per-member authentication tokens, configured member names, and relay and client
  settings.

hoptell uses this data to authenticate clients, discover peers, route messages and confirm
receipt. Authenticated clients can list other known peers' names, roles, host labels, online
status, queued-message counts and titles. Message text is routed to the addressed peers. Unless
`HOPTELL_PUSH` chooses `channel`, `tmux` or `listener`, the MCP server also reads, locally, the
IDs, user IDs, start times and command lines of the processes that started it, and the boot
identifier, to find the Claude Code process and check its channel flags. The hoptell hook
commands, whenever Claude Code runs them, read the same information to find their Claude Code
process. None of this is sent to the relay.

## The relay

- Messages travel to and from the relay over WebSocket. The relay has no built-in TLS, so
  run it on a private network or VPN, or behind a TLS proxy (`wss://`).
- The relay holds queued messages, deliveries awaiting confirmation and peer metadata in
  process memory; it does not persist that state to disk. Experimental encrypted messages are
  the exception: they are stored as described below. New admissions to this in-memory queue are
  limited to 50 messages per peer and 2,000 overall, with up to 50 additional deliveries
  awaiting confirmation per peer. Requeueing previously accepted, unconfirmed deliveries can exceed the
  normal queue limits.
- The relay's state directory holds a random realm id and, while the relay runs, a lock file
  with its process id and the relay owner's admin socket. An optional realm name comes from the
  relay's configuration and is sent to clients. Apart from the broker and access files, the
  relay's database (its audit log and the experimental encrypted-message data) and the restore
  files described below, it holds no messages, names or tokens.
- Session titles: a title can contain any text you typed into it, or a Claude Code custom name
  that another hook derived from prompt text, and every peer that may see the session's name
  sees its title. The relay keeps it in memory, with the session's hold on its name, and drops
  it when that hold ends; it is not written to the relay's database or logs. It also appears in
  other sessions' `list_peers` output, which their agent clients keep in their transcripts.
  `HOPTELL_TITLE=off` sends none.
- Name leases and reservations (which session holds a name, for up to 30 seconds after its
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
- The relay keeps access state in `<state dir>/access/` (0700/0600, not encrypted by hoptell):
  - each member's published grants: member ids, group names, times and a revision;
  - for each identity that signs in with an identity provider: the issuer and subject, the
    member id, the provider groups and times of its latest sign-in. The relay records these at
    every sign-in, also without a policy, so that a policy can use them later. When a member is
    removed, an identity unlinked, or a token revoked, the groups are dropped. The issuer,
    subject, member id, times and the reason are kept, so that an older sign-in can never count
    again. These entries stay until the operator removes them. Removing them resets that
    protection, so do it only as a deliberate reset, not as routine cleanup. Member and shared
    tokens record nothing here;
  - pending contact requests: the sender's and recipient's member ids, the sender's member name,
    a reason from a fixed list and times. They are removed after 7 days or when answered;
  - a count of requests per sender, for the current and the previous day;
  - reply allowances: two member ids and the message reference. Once used, they also hold the
    reply's message and delivery references, its operation id, a SHA-256 of its recipient, text,
    reply reference and time-to-live, and the time of use. Unused ones are removed 7 days
    after the original message was released, used ones 7 days after the reply.

  The relay removes expired entries in its periodic cleanup (every 15 seconds by default). The
  policy file belongs to the operator.
- The relay keeps a database, `<state dir>/relay.db` (0600, not encrypted by hoptell). It is
  created at the relay's first start and opened at every start, and it survives restarts. It
  always holds a random id of the database and the relay owner's audit log (described under
  "Relay administration" below).
- Encrypted direct messages are experimental and disabled by default. Enabling them (the relay's
  `--experimental-e2ee` option or `HOPTELL_EXPERIMENTAL_E2EE=1`) stores the data below in the
  same database; disabling the feature does not delete it. While the feature is enabled and the
  relay is running, periodic cleanup (every 15 seconds by default) removes expired entries and
  prunes the history described below. Cleanup is paused while the relay is stopped or the
  feature is disabled, so entries can then stay on disk longer than the times below. The
  database then also holds:
  - for each enrolled device: the member id, device id, public signing key, a hash binding that
    key to the realm, member and device, and the time of enrollment; for a revoked device, the
    time and the revocation statement, if any. These have no age-based expiry. The statements
    of its key changes are kept, with their times, for its latest 10 key changes;
  - while a member's new device waits for approval: the request (the member id, the device id,
    its public signing key, a hash binding that key to the realm, member and device, whether it
    used the reserved slot, and its creation and expiry times). If one of the member's devices
    approves it, the relay also keeps that device's id and public key, the signed approval
    (including when it was issued and expires), and the expiry separately. If the relay owner
    approves it, the relay keeps that it was an owner approval and its expiry, without a signed
    approval or an approving-device key.
    The request and its approval are removed when the device registers, the request is
    cancelled, or 24 hours after it was made. A cancelled request leaves a record of the member
    id, device id and key for 24 hours, so the same request cannot be made again sooner. When one
    of a member's devices reserves a request slot for a new device (`hoptell device expect`), the
    relay keeps the member id, the expected device id, a hash binding its key to the realm,
    member and device, and the reserving device, for up to 24 hours (or until it is replaced or
    that device registers). The relay owner's approvals and cancellations are also recorded in the audit log;
  - the KeyPackages devices upload (public keys that let another device start a conversation
    with them), until they expire (at most 14 days and 5 minutes after upload), and a record of
    each one taken (the requesting member and device, and the device it belongs to). The
    record ends when the package is used or expires, or when the reservation is given up (by
    the requester, after an hour without a group change, or when the device's key changes or it
    is revoked). It is removed once the package has expired and 7 days have passed since the
    record ended;
  - for each encrypted conversation: the two member ids, its group ids and the devices in each
    group; the group changes (MLS commits, with the member and device that made them), which
    cleanup removes after 30 days and beyond the latest 1,000 of a group; the results of
    operations, removed after 30 days; and reports from devices that could not accept a change,
    with a reason of up to 200 characters (the last 1,000 per group);
  - the messages waiting for each device. The content of an encrypted message is end-to-end
    encrypted (experimental, unreviewed). The relay records with it the conversation, the
    sender's member id and device id, the recipient's member id, device id and session name, its
    size and times. To check access again before delivery, it also records the sender's sign-in
    at the time the message was accepted: the member id, the issuer and subject of a provider
    sign-in, and the id of a broker sign-in, when there is one. A waiting message is removed when
    the recipient's device acknowledges it; otherwise it expires 7 days (plus 5 minutes
    for clock differences) after it was accepted and is no longer delivered. Group invitations
    (MLS Welcomes) and group changes waiting for a device expire 30 days after they were queued.
    Cleanup removes expired messages.
  - larger file transfers (experimental): each file's encrypted chunks (end-to-end encrypted,
    experimental, unreviewed; the relay does not have the key), with the uploading member and
    device, the transfer's id, size, chunk count, digests and times, and for each message that
    announced it the recipient member, its allowed devices and how the sender was signed in (its
    member id, its identity-provider issuer and subject, and its broker sign-in, if any), so each
    download is checked against that sign-in as it is now. A transfer is kept until 7 days
    after its upload was sealed (24 hours if it was never finished), or until the uploader
    withdraws it; cleanup then deletes its chunks in batches. A record of its id, uploader and
    final state (a tombstone) stays 30 days more, so retries are answered consistently.
- Relay administration (`hoptell relay admin`, run by the relay owner on the relay host):
  - The audit log, in the relay's database, records each change the owner makes (member
    changes, device reinstatements, backups, restores, reloads, checkpoints), each read of a
    member's grants entries, and security events the relay acts on. A row holds the time, who
    acted (the admin socket, the offline command line or the relay), a fixed action name, a
    target (a member name, a member name with a device id, or a restore id), the outcome, and
    fixed codes and counts. It holds no message text, tokens, token digests, key material or
    grants contents. Each row carries a hash of the one before it. The relay deletes rows older
    than 365 days, and the oldest rows beyond 100,000, in its maintenance (every 5 minutes
    while it runs); the last deleted row's number and hash are kept.
  - `members` commands and the admin views reach the running relay through a socket in
    `<state dir>/admin/` (0700), which only the relay's OS user can open. The views show the
    metadata above; never tokens or token digests.
  - `backup <dir>` writes a new folder (0700/0600, not encrypted by hoptell) with a copy of the
    relay's database (the audit log and any retained encrypted-message data), the access
    files, and copies of the members, policy and identity-provider files with their paths. The
    members file copy holds each member's token as the file stores it: its SHA-256, or the token
    itself for a member added to the file by hand with a plain token. The broker's files are not
    copied. Backups are kept until the owner deletes them.
  - `restore` keeps, while it runs, `<state dir>/restore/intent.json` (the backup's path, ids
    and the step reached), and keeps the replaced database and access files in
    `<state dir>/restore/<id>/before/` until the owner runs `restore --discard-evidence <id>`.
    When the access state was lost, `access/restore.json` lists the member ids whose messages
    are held, with their grants revision, until each publishes its grants again.
    `access/manifest.json` lists which access files have been written.
- The relay stops retaining a message when the receiving client confirms receipt. This
  confirms local storage or output, not that an agent read or acted on it. Restarting the
  relay discards its message and peer state, except the experimental encrypted messages
  described above. On relays supporting expiry, the sender can set a
  time-to-live (TTL). Expired queued messages are removed before forwarding or during periodic
  cleanup (every 15 seconds by default). Messages without a TTL have no scheduled expiry. This does not
  remove copies already delivered to a local inbox. Periodic cleanup removes a peer only when
  it is offline, has no queued messages and was last seen more than 6 hours ago.
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
  message twice. Delivery ids older than 8 days are removed when an agent session opens
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
- With receipts on (the default), `read_inbox` and `wait_for_message` return a batch and keep
  its message files until the receipt is acknowledged. With receipts off, reading deletes the
  files. `hoptell listen` prints and acknowledges messages; with `--no-ack` it leaves them
  waiting for acknowledgement. An acknowledgement does not prove that an agent processed the
  messages. The tmux injector and the hoptell hooks announce waiting messages with a fixed
  notice; they do not read or delete message files. Pending inbox files have no automatic
  expiry. The standalone `hoptell wait` command prints messages to standard output instead of
  storing them in the inbox.
- Contacts (who may reach your sessions) are kept in `~/.hoptell/contacts.json` (your policy:
  grants and blocks naming relay realm ids, member ids or shared-token sender names) and
  `~/.hoptell/contacts/` (the mode marker with drop counters and notification times; one record
  per sender waiting for your decision, with the sender's label and identity as the relay stated
  it, the receiving sessions and message sizes and times; decisions in progress; and the last 100
  finished requests). Held messages themselves are kept in each session folder's `quarantine/`
  (or `~/.hoptell/legacy/<name>/` for sessions on earlier relays) until you release or block them,
  or for 7 days. Desktop notifications show the sender label and session name, never message
  text. The receiving agent is told that a message was held, never its text: it sees the number
  of held messages, the request id and, only for a sender the relay authenticated as a member,
  that member's name. `~/.hoptell/contacts/reported/` keeps, per session folder, which held
  messages a `wait_for_message` call or `hoptell listen` already reported (file names only). All
  of these are under `$HOPTELL_HOME` when configured, private (0700/0600), and not encrypted by
  hoptell.
- Your own member: by default, eligible messages the relay attributes to the receiving session's
  own member can reach the agent without a grant (`HOPTELL_CONTACTS_SELF=hold` disables this
  exception). Both sessions must be in the same realm, with neither side hosted; blocks and the
  usual encryption requirements still apply. This relies on the relay's statement of who signed
  in, as grants do; a relay that lies can deliver a message as your own member. A plaintext
  message is still held if your policy requires encryption for your own member.
- Encrypted messages (experimental): `contacts.json` also keeps the device pins of your contacts
  and this home's own devices per realm (member and device ids, public signing keys, pin hashes,
  how and when each was accepted). `~/.hoptell/mls/<profile>/` holds this device's record (its
  public identity and, encrypted with a key kept in the credential store, the MLS state, the
  messages waiting to be sent and the records of the conversations), retired devices' records,
  decrypted messages waiting for a key decision (`held/`, not encrypted by hoptell, until you
  decide or they expire), and what this device last saw of your own devices
  at the relay (`own-seen.json`: device ids and fingerprints, for `hoptell doctor`). All under
  `$HOPTELL_HOME` when configured, private (0700/0600).
- Larger file transfers (experimental). Sending: `~/.hoptell/outgoing/<id>/` holds the read copy
  of the file until it is encrypted, then its ciphertext and its key, until the announcing message
  is accepted (at most 24 hours). Receiving: `~/.hoptell/incoming/` holds a ledger of transfers
  (sender, size, display label, local id, state; removed entries are dropped 7 days after
  removal) and, per transfer, the key and the decrypted file until you save it, cancel it, or 7
  days after it was fetched; `~/.hoptell/saves/` holds a save's journal until the save is
  complete. All under `$HOPTELL_HOME` when configured, private (0700/0600), and not encrypted by
  hoptell; a saved file is wherever you put it.
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
  last 7 days (at most 10,000), which relay profile and realm each message reference came
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
- Session titles from Claude Code (only with `HOPTELL_TITLE_AUTO=on`): the `SessionStart` and
  `UserPromptSubmit` hooks copy the session's custom name and its session id into
  `<key>.title.json` in `~/.hoptell/wake/` (0600, at most 1 KiB). They never copy the prompt
  field. The hook input doesn't say who set the custom name, so if another hook sets it from
  prompt text, that text is stored in this file and shared as the title. The file is removed
  together with the registration, which later SessionStart hooks clean up after about 7 days once the Claude Code process has ended; a SessionStart with
  `HOPTELL_TITLE_AUTO` off removes it. Other copies of a title: Claude Code's own transcripts and
  session files (hoptell does not write them), the relay's memory, and other sessions'
  `list_peers` output in their transcripts.
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

Review sets (`send_review_set`) keep more: a record per set under HOPTELL_HOME/review-sets
(or ~/.hoptell/review-sets) with the recipient (its name, realm and, as the relay named it, its
member id or that it used the shared token), file labels, sizes, hashes, file identities
(device, inode, mode) and optional Git commit and tree ids, and **the exact captured bytes of
every file**, so that a proposal can later be applied to them. Proposals that answer a set are
stored in the same folder with their full content (replacement text or patch), the sender as the
relay described it, and their status; at most 20 per set and 50 MB in all. Folders are 0700 and
files 0600. A set is kept for 7 days, or until every proposal for it is applied or expired
(proposals expire after 7 days), whichever is later, and is removed while an MCP server with
file tools is running. These files are not encrypted, and backups may retain them.

`hoptell apply` writes a recovery journal under HOPTELL_HOME/apply/<proposal id> (0700/0600)
before it changes a file: each target's folder id, path, identity and mode, its old and new
content, and the name and identity of the temporary file it is writing. When the apply or a
recovery completes, the journal folder is first moved to HOPTELL_HOME/apply/done/ and then
removed; an interrupted apply keeps it, beyond the review set's lifetime, until `hoptell apply
--recover` completes. The
preview uses a private temporary folder under the system temporary directory, removed before
the command ends.

The receiver's normal inbox can still contain the complete snapshot message, including file
contents, under the existing inbox retention rules. Agent sessions, terminal output and AI
providers can retain data separately. The standalone snapshot CLI prints a snapshot locally and
does not create outgoing records or send it automatically.

The MCP server writes connection and error information to standard error. CLI output, tmux
terminal content, and the agent's own conversations or logs may retain messages independently
of the inbox.

## Spawned agent runs

Spawning is off until you write and approve an agent profile (see "Spawning agents" in the README).
hoptell then keeps these files in `~/.hoptell/agents/` (under `$HOPTELL_HOME` when configured;
directories 0700, files 0600, not encrypted by hoptell):

- `profiles/<id>.json`: the profiles you wrote. `approved.json` holds the digest and approval time
  of each profile you approved.
- `runs/<run>.json`, one record per run: the profile id and digest; the CLI, its version and file
  hashes; the mode; the run's peer name, roles and relay aliases; its working folder; the spawning
  session's peer name and client; the run's state, times, lifetime and size limits; the names (not
  the values) of environment variables the profile passes on; the command path and arguments
  hoptell built (never the task); a hash of the task; the paths of your relays file and home
  folder; the process id, start time, user id and boot id of the supervisor, the agent and the
  child processes hoptell recorded; and, when the run ends, its exit code, duration and the
  result's size, hash and notes.
- `runs/<run>/`: `task.md` (the task text), `output` (the agent's standard output, up to 10 MiB),
  `log` (its error output and hoptell's notes on the run, up to 10 MiB) and `result` (the result
  text, cut to the profile's result limit). While the run is live, the folder also holds its relays
  file (relay addresses and the paths of their token files, not the tokens), a settings file and,
  depending on the CLI and mode, an MCP configuration or environment file; these are removed when
  the run ends.
- `audit.jsonl` (rotated at 10 MiB, one older file kept): one line per event, such as profile
  approvals, spawn requests and refusals, confirmations, starts, stops and ends. Events hold run
  and profile ids, digests, the spawning session's name, the working folder, error and exit codes,
  short reasons, and the result's size and hash, never the task or result text.

The agent CLI sends the task and the files it reads to its configured AI provider (see "AI
providers"). hoptell attempts to send the result to the spawning session as a peer message through
the relay, like other messages; when encryption is `required` for your own member, it is not sent.
The local copy stays in `result` either way.

For a Codex profile in path-deny hardening mode (see "Spawning agents" in the README), the run
record also holds the run's permission-profile id and the list of paths it denies: the hoptell
home, your relays file and the token files it names, and CODEX_HOME. `audit.jsonl` can also hold a
`codex_cloud_config_observed` event when Codex's cloud-config output is not the expected report
of none (for example, when it reports workspace-managed configuration): the observation class and
any fragment counts, never the rest of a cloud-config line. Hardening asks Codex's sandbox to deny
the run's reads of those paths. It does not change what the agent CLI sends to its AI provider for
the files it can read, and Codex's own helper folder inside CODEX_HOME stays readable to the run.

hoptell removes ended runs older than 7 days, and any beyond the 100 most recent ended runs;
runs from the last hour are always kept. This cleanup runs when an agent session of yours starts,
when an agent lists its runs, and with `hoptell agents list` and `hoptell doctor`. A run waiting
for your confirmation expires after an hour and is marked discarded at the next cleanup, which also
removes its settings files; its record is then removed like any other. Profiles, approvals and
audit lines stay until you delete them or the audit log rotates. To remove everything, stop live
runs with `hoptell agents stop <run>`, then delete `~/.hoptell/agents/` (or only `runs/` and the
`audit.jsonl` files, to keep your profiles).

## The owner channel over Telegram

The owner channel is off until you run `hoptell telegram setup` with a bot you created with
Telegram's BotFather. Setup checks the bot with Telegram. Once you run and pair the bridge, it
sends data to Telegram, a third party with its own
[privacy policy](https://telegram.org/privacy). Bot chats are not end-to-end encrypted: Telegram
stores them on its servers, and anyone with the bot token can read new messages to the bot.

- **Sent to Telegram** (`api.telegram.org` only): the text of each question an agent of yours
  asks with `ask_owner`, its choices, the asking agent's name and the question's number; the
  bridge's updates to a question (answered, expired, cancelled); notes from your own agents (the
  agent's name and the note's text, up to 3,000 characters); the replies to `/pending` (the asking
  agents' names, question numbers, the start of each question and its age), `/agents` (how many
  favourites you have and how many of your agents are online), `/msg` and `/help`; the bridge's
  prompts and confirmations, which name the agent; the names of your own agents (as the relay
  confirms them, and the ones you saved) as button labels (at most 10 per list or page, also in
  search results) and in the bot's command menu for your paired chat (a command and a "Message
  <name>" description per favourite, for up to 96 favourites whose names give a valid command that
  no other agent's name shares); the names you give agents, in buttons, prompts, the details screen
  and menu descriptions; and on an agent's details screen and in a "now running on" question, the
  computer name the agent reported to the relay, and when you last talked with it. Bot API requests include the bot token,
  and Telegram sees the bridge machine's IP address. An answered card may include your answer text.
  When you run `hoptell telegram identity --apply`, the bot's name, short description and
  description are sent too, and with `--photo`, the photo file you name. The bridge shows messages that your own agents send to it as notes in
  the chat; it does not forward other peers' messages, files or logs, but an agent can include
  their contents in a question or a note.
- **Received from Telegram**: the bridge receives your pairing code, answers, button presses and
  commands (including `@<agent>` and `/<agent>` instructions, messages you type before choosing
  an agent, search words, names you give agents, and replies to its prompts, confirmations and
  notes), with your Telegram user id and chat id. It drops updates from other users or
  chats and counts them without keeping their text. It signs answers and instructions and sends
  them through the relay to your agents. If an agent reads one, its configured AI provider may
  receive it (see "AI providers").
- **Stored on the bridge machine**: the bot token and the bridge's signing key in the operating
  system's keychain (or the encrypted credential file, as for `hoptell login`).
  `~/.hoptell/owner-channel/` (or `$HOPTELL_HOME/owner-channel/` when set; 0700, files 0600, not
  encrypted by hoptell) holds `bridge.json` (the bot id and username, the relay alias, the bridge
  name, the realm, the member id and the public key), `pairing.json`, `state.json` and
  `people.json`.
  `pairing.json` holds the paired Telegram user id and chat id, if paired, and the hash and expiry
  of any pending pairing code. `state.json` holds the update offset, question text and choices
  while needed, and pending actions that can contain question, answer, instruction, note or status
  text until they finish. It also holds the paired Telegram user id and pairing id it last acted
  for, each question's number and the Telegram message ids of its cards.

  `people.json` holds, per agent name of your own member and for the paired Telegram user id only:
  whether it is a favourite or hidden, the name you gave it and the computer name the relay
  reported when you gave it, when you last talked with it (a message sent, a question asked or
  answered, a note shown) and when the bridge first saw it online. Entries without a favourite,
  name or hidden mark go after 30 days without use or change, and the file holds at most 2,000
  entries.
  `unpair` keeps it; `unpair --all` deletes it. If another Telegram account pairs, the file is
  ignored and replaced.

  For notes from your agents, `state.json` holds which bot messages are notes from which agent (24
  hours, for at most the last 1,500 notes), when you last sent a message to each agent (at most
  1,000 agents; it decides whether a note notifies you), the relay ids of notes already received (8
  days, at most 5,000), and the times of recent notes per agent for the limits. For each message you
  send to an agent, it keeps the relay's id of that message, the agent's name and member, and the id
  of your Telegram message that carried it (7 days, at most 1,000 messages; cleared when the bot is
  paired again), so that a note answering it can be shown as a reply to your message.

  For targeting your agents, `state.json` also holds the buttons the bridge issued (agent names,
  your member id and Telegram message ids; usable for up to 24 hours, or until a newer list retires
  them), which bot messages name which agent (usable for up to 7 days, for at most 1,000 messages),
  and the command menu's chat id with the agent names behind each command (the bridge renews an
  agent's recorded time at most once an hour and drops the name at its first successful menu
  refresh after that time is more than 25 hours old). When you reply to a closed question, type a
  message before choosing an agent ("Who is this for?"), or the bot asks before sending to an agent
  that now runs on another computer, it holds your text until you tap a button; the buttons expire
  after 10 minutes, and the text is deleted when it is sent or cancelled, at the bridge's next
  housekeeping pass after it expires, or by `unpair --all`. While the bridge is
  stopped, expired entries, that text included, stay in the file. `menu-cleanup.json` holds the
  chat ids whose command menu Telegram did not confirm removing; `unpair --all` keeps it, and the
  next run of the same bot tries again and removes the file once the removal is confirmed.

  Closed question metadata is removed after its expiry and closure are at least a day old, no
  action is pending, and the bridge runs housekeeping; it can remain longer if the bridge is
  stopped or an action cannot finish. `audit.jsonl` (rotated at 1 MiB, one older file kept)
  records events such as pairing, questions, answers, instructions, notes shown (`noticed`: the
  agent's name, the length and a short hash), changes to favourites, names and hidden agents
  (`people`: the change and the agent's name, never the name you gave), questions about a changed
  computer (`host_warned`), refusals, dropped updates and `identity --apply` (which texts were set,
  and whether a photo was set or removed, never the file's name).
  These events hold message references, peer names, lengths and short hashes, never message
  text, tokens or chat ids. `state.json` counts dropped notes by reason (such as `notice_rate`,
  `notice_unpaired` and `notice_hidden`), without their text.
- **Stored on each agent machine**: `~/.hoptell/owner-channel/trusted.json` (or
  `$HOPTELL_HOME/owner-channel/trusted.json` when set) with the pins you
  trusted (realm, bridge name, public keys). `seen/` keeps signed-message nonces for at least
  8 days plus a safety margin, and longer if a record cannot be safely pruned;
  `received.json` counts failed verifications and suppressed replays. The messages themselves
  remain in the normal inbox.

`hoptell telegram unpair` forgets the paired chat and tries to remove its command menu in
Telegram; if Telegram does not confirm the removal, the bridge tries again when it runs. Stop the
bridge before `hoptell telegram unpair --all`. It tries to send cancellation statuses for open
questions and to remove the command menu, then clears this home's bridge, pairing and state files
and tries to remove the token and the signing key. Check its output: a status, menu or credential
removal can fail; for a menu it could not remove, the next run of the same bot on this home tries
again. `audit.jsonl`, `seen/` and `received.json` remain until you delete them. `unpair --all` also removes this bridge's signing
keys from this home's trust entry for its realm when that entry still names this bridge; check the
command's output if this fails. Pins on other machines remain until you revoke or remove them
there. This
command does not remove Telegram's messages; use Telegram's option to clear the bot chat for both
sides and see Telegram's privacy policy. `hoptell telegram trust --revoke <realm>` removes all
pins for that realm on the agent machine. Setting `HOPTELL_OWNER_CHANNEL=off` turns off the agent side (the `ask_owner` tool and
verification).

### The app

The app in Telegram is off until you run `hoptell telegram app --on`, and it needs a relay whose
operator turned it on.

- When you open the app, your phone loads it from your hoptell server, not from Telegram.
  Everything the app shows and sends passes the server's HTTPS endpoint and the relay unencrypted
  by hoptell: your list of agents with their names, favourites and hidden marks,
  the computer names, your drafts, and the start of each open question.
- To prove it is you, Telegram gives the app a signed note about you: your Telegram user id, first
  and last name, username, language, whether you have Premium, and a link to your profile photo.
  The app sends it to your bridge once when it opens; the HTTPS endpoint and the relay can read it.
  The bridge keeps only a hash of it, in memory, so that one note opens one app session at a time.
- The app stores nothing on your phone. The bridge keeps your drafts for up to 10 minutes (deleted
  when sent or cancelled), and the settings you change in `people.json`, as for the bot. In
  `state.json` it keeps whether the app is on and its link id, the ids of recent app requests (1
  hour, no text), settings changes waiting for their line in the chat, and for each change made in
  the app, the old and new value of that one setting for its `Undo` button. `Undo` is available
  for up to 24 hours for the 500 most recent changes made in the app; older buttons stop working.
  `people.json` gains a revision number, the time of the last change and the last writer's id per
  agent.
- Nothing you write in the app reaches an agent until you tap Send in the chat.
- `audit.jsonl` records app sessions (opened, closed and why), settings changes from the app (the
  agent's name and which setting), drafts (the agent's name, the length and a short hash) and
  questions shown again, never text, the signed note, tokens or your Telegram name.
- The relay keeps `apps.json` in its state directory: each app's identifier with the hoptell account
  and bridge name that registered it, its state and its last registration, until the relay operator removes it.
  Its log records the start of the app id, the status and the duration of each request, never
  bodies or the session token.
- `unpair --all` deletes the app's state with `state.json`; the relay's `apps.json` entry stays
  until the relay operator removes it (`hoptell relay apps --purge`).

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
  separately according to your setup. The relay's database, including its audit log, stays in
  the state directory until you delete it; delete backup folders yourself, and restore evidence
  with `hoptell relay admin restore --discard-evidence <id>`.
- Each machine: stop the relevant hoptell processes, then delete `~/.hoptell` or the
  configured `$HOPTELL_HOME` directory to remove local inbox and session files. Remove stored
  tokens from the settings sources you used.
- Spawned agent runs: stop live runs with `hoptell agents stop <run>`, then delete
  `~/.hoptell/agents/` (see "Spawned agent runs").
- Owner channel: stop the bridge, run `hoptell telegram unpair --all` on the bridge machine and
  check its output (see "The owner channel over Telegram"); delete the remaining
  `owner-channel` directories on each machine, and clear the bot chat in Telegram for the copies
  there.

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
