# Changelog

## Unreleased

- Session titles: `HOPTELL_TITLE=<text>` shows a short title next to the session's name in other
  sessions' `list_peers`, for example `emin-mac-61034 (host: mac) title: "review docs" online`.
  The title is a label only: messages still go to the name, and no access decision reads it.
  hoptell removes control and invisible characters and keeps at most 80 characters.
  `HOPTELL_TITLE=off` sends none. Titles need an updated relay; earlier relays ignore them.
- Claude Code session names as titles: with `HOPTELL_TITLE_AUTO=on`, a session with the hoptell
  plugin uses its custom name (`claude --name`, `/rename`). The plugin has a new
  `UserPromptSubmit` hook that copies only the name and the session id. Claude Code does not say
  whether the user, a hook or a tool set the custom name. Another hook may derive it from prompt
  text. With `HOPTELL_TITLE_AUTO=on`, hoptell stores and shares that title. The hooks never copy
  the prompt field. Off by default; an explicit `HOPTELL_TITLE` wins. A live session updates its title at the relay with
  the new `set_title` frame (at most 10 changes a minute per session, 60 per member).
- `list_peers` now shows the host as `(host: <host>)`.

## 0.3.0 (2026-10-15)

This release adds a large set of features and changes the relay protocol. Upgrade the relay
and every client together; see "Upgrading" at the end of this entry.

- Agent spawning: an agent session can start another agent on the same machine for one task,
  within limits you set in a profile (`~/.hoptell/agents/profiles/<id>.json`, schema
  `schema/agent-profile.schema.json`). New MCP tools: `spawn_agent`, `list_agents` and
  `stop_agent`. Only Codex in headless mode with its `read-only` sandbox is enabled, on the tested
  Codex 0.162.1 build; other CLIs and modes are refused. A profile is used only while its content
  is exactly what you approved. List profiles with `hoptell agents profiles`. To approve a Codex
  profile from the CLI, read the warning and run `hoptell agents profile approve <id>
  --accept-read-risk`; `hoptell ui` also shows the warning before approval. The warning says that
  a run uses your account and may read its files, including relay tokens. Runs can wait for your
  confirmation (`hoptell agents confirm <run> --start|--discard`), and `hoptell agents list`,
  `stop` and `result` manage them. A run gets its own hoptell MCP server with six tools, excluding
  `spawn_agent` and `ask_owner`. Codex can still create its own sub-agents in `plain` mode;
  hardening mode turns them off. See "Spawning agents" in the README.
- Optional path-deny hardening for spawned Codex runs (`"codex": {"headlessMode": "hardening"}`
  in the profile, Codex 0.162.1 only): Codex's OS sandbox is asked to deny reads of the hoptell
  home, your relays file, the token files it names, and CODEX_HOME. It is hardening, not
  containment; the default mode stays `plain`.
- The owner channel over Telegram: agents can ask you a question with the new `ask_owner` tool,
  and you can answer and send them instructions from a Telegram chat with your own bot. A single
  bridge process (`hoptell telegram setup`, `run`, `pair`) serves your agents on every machine
  through the relay, as a peer of your own member. Each agent machine trusts the bridge's signing
  key with `hoptell telegram trust '<pin>'`; only messages signed with a trusted key are shown as
  yours. You can pick an agent with buttons, reply to its messages, use `/msg`, `/agents`,
  `/pending` and menu shortcuts for eligible favourites, and agents can send you short notes with
  `send_message`. Favourites, names and hidden agents are kept on the bridge machine. An answer
  or instruction from the owner channel never approves a hoptell decision or a CLI permission
  prompt. Telegram is a third party and bot chats are not end-to-end encrypted: see "The owner
  channel over Telegram" in the README and PRIVACY.md. It is off until you set it up, and
  `HOPTELL_OWNER_CHANNEL=off` hides `ask_owner` on an agent machine.
- `hoptell telegram identity` previews the bot's name and descriptions; `--apply` updates them
  after confirmation. With `--apply`, `--photo <file.jpg>` uploads a profile photo and
  `--remove-photo` removes it, also after confirmation.
- An optional Mini App for the owner channel, off by default: your agents grouped by computer,
  with search, and your open questions. The relay operator turns it on with
  `HOPTELL_OWNER_APP=on` (the relay must be served over HTTPS), and the bridge owner with
  `hoptell telegram app --on`. Messages drafted in the app are sent only after a tap in the chat,
  and settings changed there can be undone. When the bridge reaches the relay at a private
  address or over `ws://`, set `HOPTELL_APP_URL` in the bridge's environment to the relay's
  public HTTPS address.
- Direct sends can name the recipient's member (`to_member`); the relay checks it when the
  message is accepted and again before every delivery. The relay can also list the sessions of
  the caller's own member (`list_own`). The owner channel needs both.
- Under an encryption policy of `required` for your own member, features that send plaintext
  between your own sessions now refuse instead of sending: `ask_owner` answers
  `encryption_required`, `spawn_agent` refuses and a run's result is not sent (`hoptell agents
  result <run>` still prints it), and `hoptell telegram run` exits with code 78.
- A second process waiting for a session name already in use (for example, another MCP process
  for the same Codex session) can now send messages and list peers through a short-lived
  send-only connection. The relay accepts a send only while the name is held by the same member
  or shared-token identity. Sending this way requires a relay that supports the check.
- When the relay refuses a name for a member token, the client, `hoptell doctor` and the
  Telegram bridge now say which names are allowed: the member's own name, or names that start
  with it and `-` (the relay now tells a refused client its member's name).
- `--help` or `-h` among a command's options (before a lone `--`) prints that command's help and
  does nothing else. In `hoptell send`, the message text is not searched for options: a message
  that mentions `--help` is sent, and only a message that is just `--help` or `-h` shows the help.
  Before, some commands ran instead (`hoptell members revoke <name> --help`
  removed the member, and `hoptell relay --help` could start a relay). `hoptell help <command>`,
  and `help` as the first word of `agents`, `contacts`, `members`, `relay`, `telegram` and other
  commands with subcommands, do the same. Commands now refuse options they do not know instead of
  ignoring them. `hoptell --version` (or `-v`) prints the version. `hoptell help` now lists every
  command and the relay's options.
- `hoptell wait` now earns a reply allowance for the messages it prints, as an agent session
  does: you can reply once to a message you received, even when the sender's grants do not let
  you reach them.
- `hoptell relay admin` views (`status`, `members`, `store` and the others) no longer create an
  empty relay store in a directory without relay state: they say that no relay state is there.
- `hoptell grants` refuses an invalid selector before the preview, not only when publishing.
- `hoptell agents profile approve` refuses an invalid profile before it shows the Codex warning,
  and refuses Codex profiles that cannot run on this hoptell (tmux mode, or headless mode with
  the `workspace-write` sandbox).
- `hoptell contacts show` no longer offers `allow` or `allow-once` for unencrypted messages from
  a contact whose encryption is required, since those commands are refused.
- A credential that cannot be saved in the OS keychain (for example `hoptell device enroll`)
  now shows how to use the encrypted credential file instead.
- Received encrypted messages are marked as end-to-end encrypted, and their Sender line names
  the member's id as an id (not as its name).
- A message shown again because an earlier read did not acknowledge it now says so, instead of
  "not acknowledged in time".
- `hoptell tmux`: the injector no longer presses Enter while Codex's transcript selection is
  open or when it cannot see its own notice in the prompt; a notice left in the prompt is
  submitted only on stable observations, and handed to you when you changed it. Fresh Codex
  sessions' `»` prompt glyph is recognized.
- Relays under systemd: a `DynamicUser` state directory (a symlink) is accepted, the owner app's
  files are written where it resolves, and the relay and `hoptell relay admin` read the members
  file from systemd's `LoadCredential` copy. The admin socket's path length is checked before
  the relay listens.
- Fixed: `hoptell telegram run` exited with code 13 when the relay restarted; it now waits and
  reconnects.
- Fixed: a relay backup whose first step met a database lock failed instead of being retried.
- Fixed: when a managed `contacts.json` was missing, unreadable or invalid, outgoing sends
  ignored its encryption policy and went out as plaintext, even to contacts whose encryption is
  required. Agent sessions, `hoptell send`, the owner-channel bridge and spawned runs now refuse
  sends and report the policy error; the bridge keeps answers until the file is fixed.
- Fixed: after a relay restore that lost its access state, a send to a member that had not yet
  published its grants again got a different answer from a send to an unknown name, so any
  member could tell which names exist, hidden members included. A pending member now answers
  `unknown peer`, matching an unknown name.
- Fixed: in a new install, the owner's verified answers to `ask_owner` were held by contacts
  until you allowed your own member. Signed owner-channel messages that the agent's machine
  verified, sent by your own member, now reach the agent without a grant; blocks and a
  `required` encryption policy still apply. The exception needs a receipt that the agent's
  machine records when it verifies the message, and it checks the stored signature against the
  key trusted now. `hoptell wait` no longer keeps a relay's claim that a new message was verified
  or decrypted.
- Fixed: on a relay that accepts both a shared token and member tokens, a protocol-1 client with
  the shared token could take over a member's protocol-1 session of the same name, and the
  reverse. A protocol-1 client now replaces only a session of the same member, or another session
  using the shared token.
- Fixed: when a members reload added a hosted member, existing shared-token connections could keep
  that member's names. They are now disconnected, and their name reservations are released.
- Fixed: messages stored by an older version could still show the "your owner" Sender line, or
  count as end-to-end encrypted, because of a field that an older `hoptell wait` copied from the
  relay. The owner-channel label and the encryption mark now require a receipt that this version
  records when it verifies or decrypts a message, and the owner label also requires a stored
  signature verified against a currently trusted key. Older records lose the label, and under a
  `required` encryption policy their messages are held as plaintext.
- Fixed: a device outside an encrypted conversation could learn from the relay's answers to its
  sends whether the conversation's members allowed it or could not be checked. The relay now
  checks that the sending device belongs to the conversation first, and gives a device outside it
  an answer that does not depend on the members' access rules.
- `stop_agent` stops only runs that the calling session started; `hoptell agents stop` still
  stops any run.
- The release workflow checks the package against the committed release-gate records before
  publishing.

- Encrypted messages (experimental): when a member has a registered device that remains unrevoked,
  a new device needs approval from an active device of the member or from the relay owner. Run
  `hoptell device enroll` on the new device. On an existing device, run `hoptell device accept
  <device>`, compare the fingerprint, then run the `--set <code>` command it prints to accept the
  device and send a signed approval. If the new device has stopped waiting, run `hoptell device
  enroll` again to finish registration. An approval that could not be sent is kept and retried
  when the approving device next connects. While any registered device remains unrevoked, a member
  token alone cannot register another one, so a token holder cannot use a new device to revoke the
  member's existing devices. New commands: `hoptell device pending [--cancel <device>]` and
  `hoptell device expect <device> <pin identity>` (`hoptell device status` prints the pin
  identity). Relay owners can list requests with `hoptell relay admin devices pending [--member
  <name>]`, approve one with `hoptell relay admin devices approve <member> <device> <fingerprint>`
  or `hoptell members device-approve <member> <device> <fingerprint>`, and cancel one with
  `hoptell relay admin devices pending-cancel <member> <device>`. If a member has no registered
  device that remains unrevoked, a new device can register without approval. Upgrading a relay:
  devices registered before the upgrade remain active; the relay cannot tell which were added
  using only a member token. After upgrading, each member's owner should review those devices with
  `hoptell device list` and revoke any they do not recognize. `hoptell doctor` also warns about
  devices you have not accepted that hoptell last saw at the relay, but it is not a full device
  list. Upgrade clients too: an older hoptell cannot attach as a device or enroll a new device on
  the upgraded relay.
- Encrypted messages (experimental): a connection acts for a device only after it signs a fresh
  relay challenge with the device key; a member token alone no longer receives a device's
  messages or touches its KeyPackages. An older hoptell needs an update to attach to such a
  relay. Device commands such as `hoptell device replenish` receive none of the device's messages.
  An interrupted key rotation is retried at the next start.
- With an MLS binding that can prune, the private keys of expired, unused KeyPackages are deleted
  after a one-day grace period, within six hours while the engine runs; `hoptell doctor` says when
  the binding cannot.
- Experimental encrypted messages: your own devices are trusted only when you accept them.
  Another device of yours is trusted after `hoptell device accept <device>` on a device you
  already accepted (and the same on it), never because the relay lists it. An existing home is
  upgraded once: its device becomes the baseline, and other devices of yours that an earlier
  version pinned from the relay's list become unconfirmed; conversations holding one stop until
  you accept or revoke it. A home holds one device per relay realm: a second profile in the same
  realm is refused, and `hoptell device retire` gives one up. Retiring the profile that holds the
  realm's own device keeps its record, marked retired, and any later enrollment in that realm
  needs `hoptell device enroll --new-baseline`. That command starts again with a new device id
  on your explicit confirmation (after such a retire, when every device of yours is lost, or when
  this device's record cannot be read), and keeps the replaced record for review.
  Enrolling needs managed contacts (`hoptell contacts init`).
- `hoptell contacts verify` shows your devices and the contact's, with fingerprints and states;
  the safety number's own half comes from the devices you accepted. It refuses while the relay
  lists a device of yours you have not accepted, and it does not pin while a pinned device of the
  contact is no longer listed. A pinned device the relay stops listing is no longer removed:
  messages to that contact wait until it is listed again, a trusted revocation arrives, or you run
  `hoptell contacts forget-device <member id> <device>`. A message that reached no device of the
  contact is reported as not delivered, and the relay refuses one before accepting it.
- Encrypted conversations send an update at least every 7 days of activity and after a member is
  removed (before the next send when a device was idle); `hoptell doctor` lists members without
  an update for more than 30 days.
- Encrypted messaging requires the post-quantum MLS suite 0x004D: a binding without it is
  refused, and a device stored with another suite does not load (enroll a new device).
  Device-signed rotation, revocation and `hoptell device migrate` check that the binding can
  sign before changing anything.
- Larger file transfers: the relay's upload policy is checked whenever it would accept new work
  (a chunk, the seal, the announcing message), not only when the upload begins. A refused upload
  ends as denied, and the sender's outbox reports it and cleans up.

- Experimental larger file transfers (with `HOPTELL_EXPERIMENTAL_E2EE=1` and a relay started with
  `--experimental-e2ee`): `send_transfer` sends one file of any content, up to 200 MiB, to one
  peer. It is read once, encrypted in 256 KiB chunks with a key used for that transfer only, and
  stored encrypted at the relay for 7 days; the key travels inside the encrypted message that
  announces it, and the relay serves the chunks only to the recipient's devices of that message.
  The recipient fetches it only from contacts allowed under `transfers` in `contacts.json`,
  within this home's limits, and saves it with `hoptell save <t_id> <path>` (never replacing a
  file without `--overwrite`); `hoptell transfers` lists what is staged. A review set larger than
  one frame goes as a transfer (up to 8 MiB) when encrypted messages reach the peer.
  `hoptell doctor` finishes interrupted saves and, with `--fix`, removes leftovers. A restored
  relay store never serves a transfer again that the replaced store had ended.
- Relay store: every write is admitted against the size of the write-ahead log
  (`--wal-soft-limit`, `--wal-hard-limit`): uploads wait first, then messages and commits, and
  maintenance last, until a checkpoint succeeds; reads go on. Sweeps work in bounded batches. New
  stores use 4 KiB pages with incremental vacuum, and a store with another page size is refused.
  `hoptell relay admin store` shows the limits and the refusals by class.
- Experimental hosted MCP endpoints (`hoptell mcp-hosted --experimental`): a relay operator
  serves MCP for people whose clients cannot run hoptell. The host can read their messages, so
  hosted members are separate members in hosted custody, labeled for their peers, without
  devices, and never sent to under a `required` encryption policy; an encrypted fan-out leaves
  them out and counts them in its result. A relay policy with provider groups fences hosted
  custody. Owners decide held contacts on a hosted owner page. Limits and retention are
  placeholders, still open.
- Encrypted messages stay experimental until an independent review: an encrypted send's result
  says "encrypted (experimental, unreviewed)", and `hoptell doctor` says "encrypted messaging:
  experimental, not independently reviewed" whenever `HOPTELL_EXPERIMENTAL_E2EE` is set. An MLS
  binding named by `HOPTELL_MLS_WASM` or `HOPTELL_MLS_DRIVER` always keeps that label. No MLS
  library is loaded by default. To try it, set `HOPTELL_MLS_WASM` to the binding shipped in the
  package (`lib/mls/binding`, by absolute path) or to a wasm-bindgen build for Node.js; when a
  binding cannot be loaded, the error says why. See "Encrypted messages" in the README.
- Relay administration (`hoptell relay admin`) for the relay owner, on the relay host: views of
  members (whether each has a token and how it is stored, never the token), devices, the policy,
  grants summaries, revocations, metrics and the store's health, and an audit log of every change
  (a hash chain, without message text, tokens or key material). `members` commands and
  `relay broker-reset` record what they do there. With the relay running, the commands go through
  a private admin socket in the state directory; with it stopped, they open the store themselves.
  Online backups (`backup <dir>`) and an offline, resumable `restore` that never rolls
  authorization back: grants, denies and used reply allowances stay as they are, and if the
  access state was lost, messages to each member wait until that member publishes its grants
  again. With the experimental encrypted messages, a restore makes each conversation replace
  its group before its next commit, and encrypted messages accepted after the backup are lost.
  `ui` serves a read-only page on loopback. The relay now opens its store at every start.
- `hoptell ui`: the owner's pages on 127.0.0.1, without JavaScript, for what waits for a
  decision, contacts, devices, settings and a doctor summary. A single-use launch link opens the
  session; the Host, Origin and Sec-Fetch-Site are checked, and every form carries a token bound
  to the session and to the choices it offered. The CLI and the UI decide through one shared
  service, and a decision is refused when what was shown changed. Settings are written only if
  the file did not change since it was shown; values from the environment are shown, not
  written. With the experimental encrypted messages, a contact's encryption is a setting there,
  held plaintext from a contact whose encryption is required is shown with a link to it, and
  the encrypted conversation's checkpoint has its own page.
- Optional: with `HOPTELL_ELICITATION=read_inbox`, `read_inbox` may first ask the owner in the
  client's own dialog about one held sender (`allow-once` or `later`), on MCP revisions
  2025-06-18 and 2025-11-25 only, within 60 seconds, with a 30-minute pause after a decline.
- `hoptell contacts allow-once` is now refused while the contacts policy is damaged, as `allow`
  and `block` already were.
- Access control at the relay, in two parts. Each part can only refuse a message:
  - an operator policy (`hoptell relay --policy`), with groups of members or identity-provider
    groups;
  - per-member grants (`hoptell grants`), which say who may reach you, with expiry, revisions
    and hiding from lists. A grants change is published only against the revision you previewed.

  Refused senders get the same answer as for unknown names. They can reply once to a message
  that reached their session. They can also send a contact request with a fixed reason
  (`hoptell contacts request`, answered with `hoptell contacts requests`).

  Removing a member, unlinking an identity or revoking a token ends the group claims the relay
  holds for it. Messages queued by a broker sign-in that has ended are not delivered. Without a
  policy or grants, delivery does not change.
- Review sets: `send_review_set` sends several files from approved folders to one peer as one
  immutable manifest (per-file SHA-256, a `bundle_digest` over the RFC 8785 canonical JSON of
  the file list, optional Git provenance), and keeps the captured bytes locally.
  `verify_review_set` checks them later. The reviewer's hoptell checks every file against its
  hash. A reviewer answers with a proposal (replacements or single-file patches, by file id);
  it is checked completely before it is stored, and the agent only learns that it is waiting.
  A proposal is accepted only from the recipient the relay named when the set was sent: the
  relay's acknowledgement of a direct send (protocol 2) now names the recipient's member, or
  says that it used the shared token. With an older relay that names no recipient, the check is
  weaker (any authenticated sender with that name in the realm), and the tool result and the
  apply preview say so. A set whose confirmation was not saved accepts no proposal. Files inside
  `.git` cannot be part of a review set.
- `hoptell apply` lets the owner preview and apply a proposal from the terminal: changes are
  applied to the captured bytes in a temporary folder (Git 2.39.2 or a fixed release, no
  configuration, hooks or filters), every file is checked again before writing, and a recovery
  journal makes an interrupted apply recoverable with `hoptell apply --recover`. An apply is
  committed once its complete journal state is saved: recovery then only finishes it, and refuses
  a roll-back.
  Each file is replaced by a new file with the same permission bits; ACLs and extended
  attributes are not kept. `hoptell doctor` reports an unfinished journal.
- `hoptell mcp-http` serves MCP over HTTP on 127.0.0.1 for clients that only speak HTTP: per-client
  tokens (stored hashed), loopback Host check, no web-page requests, one agent session per client
  session, limits on sessions, calls and streams. Reads are held under receipts until they are
  acknowledged, so a response lost with its connection is shown again. `hoptell hook-header` lets
  such a client use Claude Code hook notices.
- One agent session can use several relays (a relays file): peers are addressed as `name@relay`,
  bare names go only to the default relay, and nothing is forwarded between relays. Reads merge
  every relay with one receipt; replies go back through the relay their message came from.
  Relays can be send-only. `hoptell send|list|wait` accept `--relay` and `name@relay`.
- Sign-in with an identity provider (OIDC), tested with Keycloak. A relay started with
  `--oidc <file>` accepts access tokens that the provider issues for the relay, checked with
  the provider's keys or by introspection. `hoptell members link` links an identity to a
  member. `hoptell login` signs in with the browser (authorization code with PKCE), with a code
  on another device, or as a service account. With `HOPTELL_AUTH=login`, sessions sign in
  without a token. Tokens are renewed on the live connection. Credentials are kept in the OS
  keychain or, by choice, an encrypted file. `hoptell logout` removes and revokes them.
  `hoptell doctor` shows the sign-in. Member tokens keep working.
- Broker mode for providers that only sign users in (ID tokens, no access tokens for the
  relay): the relay signs the user in at the provider and issues its own credential to
  `hoptell login`. Refresh tokens are used once; a reused one ends that sign-in everywhere.
  `hoptell members signout <name>` ends a member's broker sign-ins, and `hoptell relay
  broker-reset` recovers from a lost key.
- `hoptell local-relay` runs a private relay for your own sessions on this machine as a user
  service (macOS LaunchAgent, Linux systemd user unit): loopback only, members only, with a
  token only your account can read. `hoptell doctor` shows its state.
- Relays report whether names are authenticated with a shared token, per-member
  tokens or both. `hoptell doctor` displays the mode and warns when a shared-token
  holder can use a member's name.
- `hoptell send`, `list` and `wait` retry connection attempts within their time
  limits. `wait` also reconnects after a dropped connection. Rejected credentials
  and name takeovers stop retries. Sends with an uncertain outcome are never
  retried automatically.
- Closing a relay client cancels reconnects and name checks and settles pending
  waits and requests.
- `--trusted-proxies` enables client-address logging behind a reverse proxy.
  Forwarded headers are read only from configured proxies and used only in logs.
- Optional JSON Lines logging (`--log-format json`) replaces control characters
  in logged values. An optional metrics endpoint (`--metrics-port`) exposes
  aggregate counts, sizes and ages and binds to 127.0.0.1 by default.
- `hoptell doctor --relay-check` sends a test message to a temporary receiver and
  reports the elapsed time for connection setup, delivery and acknowledgement.
- Node.js 22 or newer is required (a relay needs 22.13 or newer, see "Upgrading"). CI runs on
  Node.js 22 and 24.
- The README documents the observed client behavior and configurations.
- Peer names are leased (relay protocol 2). While a session is online, another
  connection cannot take its name. When a session's connection drops, other
  members cannot take the name for 30 seconds, but the same member can (for
  example a restarted session); a clean exit frees it at once. A second agent session with the same
  name waits for it. `hoptell wait` stops instead, or waits with
  `--wait-for-name`, or takes the name over once with `--replace`. Clients fall
  back to the earlier protocol with earlier relays; `HOPTELL_PROTOCOL=1` keeps it.
- Without `HOPTELL_NAME`, the relay assigns the name: `<member>-<host>-<n>` with a
  member token, `<host>-<n>` with the shared token.
- Each relay has a realm id, kept in its state directory (`--state-dir`,
  `HOPTELL_STATE_DIR`; the Docker image uses `/data`). Clients record it per relay
  and refuse a relay URL that starts answering with another realm.
- Messages show how the relay says the sender signed in: member name and id, the
  shared token, or unknown with earlier relays.
- Agent sessions keep messages in a folder bound to the relay realm, member and
  session, and usually store a redelivered message only once. `hoptell listen --session`
  reads such a folder.
- Messages stay until acknowledged (receipts). `read_inbox` and `wait_for_message`
  return a batch with a receipt, which the agent passes back as `ack` (or with the
  new `ack_messages` tool) once handled; unacknowledged batches are shown again
  after a lease (`HOPTELL_LEASE_MINUTES`, default 30). `hoptell listen` acknowledges
  after printing; `--no-ack` prints a receipt for `hoptell ack`. `HOPTELL_RECEIPTS=off`
  keeps read-means-removed.
- Received messages are written durably before they are confirmed; a session's
  inbox holds at most 1,000 messages or 50 MB, and further messages wait at the
  relay until room is freed.
- Sends carry an operation id on relays that support it: when a reply is lost, the
  client resends to the same relay instance and the relay delivers the message once.
- Contacts: you decide who may reach your agent sessions. In a new install, senders
  without a grant are held back until you decide with `hoptell contacts` (allow,
  allow once, block); the agent only sees how many messages wait, and a desktop
  notification points you to the command. Existing installs keep today's behavior
  until `hoptell contacts init`. Decisions name the exact revisions you were shown,
  so a newer block is never undone by an older allow. `hoptell doctor` summarizes it.
- `hoptell members list|add|revoke|migrate` manages the members file on the relay
  host. New tokens are shown once and stored as SHA-256. Members get immutable ids;
  `--require-members` refuses a shared token. The relay refuses duplicate ids and a
  token used by two credentials.
- `hoptell doctor` shows the relay realm, the member it signed in as, and whether
  the local relay profile agrees.
- An option that takes a value is refused when the value is missing or empty (exit 2). Before, the
  CLI silently used the option's default: for example, `hoptell local-relay install --port`
  installed on port 7788, and `hoptell grants allow '*' --until` previewed a permanent allow. An
  identity-provider subject that starts with `--` is given as `--subject=<subject>` (`members
  link|unlink`, `mcp-hosted link|unlink`).
- Invalid `hoptell relay` options and configuration files are rejected before the relay creates or
  locks its state directory. This includes a `--wal-hard-limit` below the default soft limit
  (256MiB) when `--wal-soft-limit` is not set. An invalid `--metrics-port` is refused before
  the relay starts listening. `--transfer-quota` and `--transfer-member-quota` values are checked
  even without `--experimental-e2ee`, and the relay says that they are ignored without it.
- `hoptell wait` and `hoptell listen` now require `[seconds]` to be an integer from 1 to
  2,147,483. Previously, zero and nonnumeric values used the default, while negative and
  fractional values were accepted. Help and README now state the 300- and 3,600-second defaults.
- `hoptell login` checks its options (`--mode`, `--store file`, `--client-credentials` with
  `--client-id` and `--client-secret-file`, not with `--device`) before it reads or creates
  anything or contacts the relay. If the relay offers no sign-in, `login` now says so instead of
  "the relay answered 426".
- `hoptell mcp-http --port` and `hoptell relay admin ui --port` refuse a value that is not a port
  number with a clear message. `hoptell mcp-http client add` refuses an invalid `--name`, and
  `client remove` on a home without clients says there is no such client.
- Invalid `contacts` and `grants` arguments no longer create contacts files in a new home. With
  device keys enabled, this includes missing required operands, invalid encryption modes, invalid
  `contacts verify --how` values, and `contacts verify --yes` unless both `--how` and `--set` are
  supplied. `list`, `send`, `grants`, `wait`, and `login` also leave a new home untouched when
  `HOPTELL_RELAY` is missing, is not a URL, has an unsupported scheme, contains a fragment, or is a
  `ws+unix:` URL with an empty path, or when `HOPTELL_PROFILE` is invalid. `login` also checks that
  the URL is `wss://` (or loopback) first.
- `list`, `send`, `grants`, and `wait` check `HOPTELL_PROTOCOL` and `HOPTELL_NAME` (and
  `HOPTELL_ROLES` for `wait`) before they open the contacts, and refuse a `HOPTELL_AUTH` other
  than `token` or `login`, as agent sessions do. Before, any other value meant `token`.
- `hoptell relay admin backup --pages` now requires a whole number of at least 16. Previously, a
  nonnumeric value could select the default on a running relay. `hoptell members add` refuses an
  invalid name before it opens the relay's state, and `hoptell mcp --home` without `--run` is
  refused.
- `hoptell telegram` subcommands and `hoptell local-relay` refuse words and options they do not
  take (such as `telegram pair --all`, or `local-relay status --purge`) instead of ignoring them.
  `hoptell hook-header --help` prints its help.
- A setting with a value it does not accept is no longer read silently as its default. The relay,
  an agent session, or a command refuses to start for `HOPTELL_REQUIRE_MEMBERS`,
  `HOPTELL_OWNER_APP`, `HOPTELL_EXPERIMENTAL_E2EE`, `HOPTELL_AUTH` and `HOPTELL_CREDENTIAL_STORE`,
  and the message names the variable and the accepted values. Before, `HOPTELL_REQUIRE_MEMBERS=2`
  allowed the shared token, and `HOPTELL_CREDENTIAL_STORE=vault` used the OS keychain. The on/off
  switches take `1`, `true`, `on` or `yes`, and `0`, `false`, `off` or `no`, in any case. An invalid
  `HOPTELL_AGENTS_MAX` (such as `0`) refuses spawning instead of allowing 4 runs. For
  `HOPTELL_NOTIFY`, `HOPTELL_OWNER_CHANNEL` and `HOPTELL_ELICITATION`, a warning names the value
  used instead. `hoptell doctor` lists these problems.

### Upgrading

- Clients need Node.js 22 or newer. A relay needs Node.js 22.13 or newer to start, and 22.16 or
  newer for online backups (`hoptell relay admin backup`); Node.js 24 also works.
- Upgrade the relay and the clients together. Clients of this version use relay protocol 2
  (leased names) and fall back to protocol 1 with an older relay.
  With the experimental encrypted messages, an older client cannot attach as a device to an
  upgraded relay, and devices registered before the upgrade should be reviewed with
  `hoptell device list`.
- Per-member tokens (`hoptell members`) are needed for the owner channel and recommended
  everywhere; `--require-members` refuses the shared token. Without `HOPTELL_NAME`, the relay now
  assigns session names.
- Contacts: new installs hold senders without a grant until you decide; existing installs keep
  their behavior until `hoptell contacts init`.
- Unread messages that a 0.2 session left in `~/.hoptell/inbox/<name>/` move once into the
  storage of the first session that connects to an upgraded relay with that `HOPTELL_NAME`. They
  are then shown and acknowledged like any other message, and the contacts decide who reaches
  the agent. Sessions without `HOPTELL_NAME` had automatic names, so their messages stay where
  they are (`hoptell doctor` counts them): read them with 0.2.2 before you upgrade.
- The owner channel needs a relay of this version (`to_member`, `list_own`). The Mini App also
  needs `HOPTELL_OWNER_APP=on` on the relay and, when the bridge does not reach the relay at its
  public `wss://` address, `HOPTELL_APP_URL` on the bridge.

## 0.2.2 (2026-10-08)

- `hoptell tmux` now starts tmux servers without `HOPTELL_` variables in their
  global environment. Previously, later sessions could inherit the relay URL,
  token and `HOPTELL_PUSH=tmux`, causing Claude Code started in ordinary tmux
  to wait for notices from an injector that was not running.
  `hoptell doctor` detects these variables in an existing tmux server’s global
  environment and prints commands to remove them, without showing their values.

## 0.2.1 (2026-10-08)

- A replaced MCP session now reconnects automatically once its peer name is free again.
  Previously, it stayed offline until restarted. This lets it recover when an agent starts
  a temporary copy of its MCP server to list tools, as Codex does for `/mcp`. While the
  newer connection is online, the replaced session waits. It checks at increasing intervals,
  from two seconds up to one minute. Names longer than 58 characters still require a restart.
- For contributors: `npm run test:compat` tests every combination of old and current
  relays, senders and receivers. By default, it installs the newest npm release older than
  this checkout's version.
- Fixed an intermittent hang in the hook delivery tests. Cleanup now stops the stand-in
  Claude Code process and its MCP servers before removing their files. Closing a test
  relay also closes connections that have not finished sending their HTTP upgrade request.

## 0.2.0 (2026-10-08)

- `hoptell doctor` checks this machine's setup: Node.js version, settings file and its
  permissions, relay URL, token (never printed), peer name and roles, delivery mode, relay
  health and login, online peers, inbox, hook sessions and tmux. It exits with status 1 if any
  check fails.
- Message expiry: `send_message` accepts an optional `ttl_seconds`, and `hoptell send` accepts
  an optional `--ttl` (for example `--ttl 10m`, at most 7 days). If the message is still
  waiting in the relay's queue when its time-to-live expires, the relay drops it. Expiry
  does not delete messages already stored in a local inbox. Older relays ignore this setting.
- Message references: every accepted send gets a `Message reference`, shown by clients from
  0.2.0 after the message text and in the send result. `send_message` accepts `reply_to` and
  `hoptell send` accepts `--reply-to`, so the recipient sees which message an answer refers to.
  The relay logs references, routing events and receipt acknowledgements. Its logging calls do
  not explicitly include the message-text field.
- `hoptell snapshot <file>` prints a text file with the SHA-256 of its exact bytes for review,
  and `hoptell snapshot --check <sha256> <file>` reports whether the file still matches before
  a suggested change is applied.
- File tools, off by default: with approved folders configured (`HOPTELL_SNAPSHOT_ROOTS`, or
  the plugin's "Approved snapshot folders" setting), `send_file` sends a checked snapshot of a
  file to one peer and keeps a private local record, and `verify_snapshot` reports whether the
  file still matches. macOS and Linux only.
- Optional keyed fingerprints in relay logs on macOS and Linux:
  `HOPTELL_LOG_FINGERPRINTS=on` with `HOPTELL_LOG_FINGERPRINT_KEY_FILE` set to a private key
  file adds an HMAC-SHA-256 tag of the message text on routing and delivery events, using
  the message reference as a nonce. Off by default; tags are never sent to clients.
  `hoptell doctor` reports the local setting.
- The relay re-reads its members file on `SIGHUP`: connections authenticated with removed or
  changed member credentials are closed, and the relay stops serving them at once. Invalid
  updates leave the active members list unchanged.
- Hook delivery for Claude Code: the plugin's `SessionStart` hook registers a watched file,
  and its `FileChanged` hook wakes an idle session with a fixed notice when messages are
  waiting, without the channels flag. Automatic mode chooses an enabled hoptell channel
  first, then hooks if they answer a silent check at startup, otherwise listener delivery.
  `hoptell hooks` prints hook settings for setups without the plugin. Explicit
  `HOPTELL_PUSH=hook` does not fall back to listener delivery.
- `HOPTELL_PUSH` accepts `channel`, `hook`, `tmux` or `listener`. Each MCP server selects one
  delivery mode; in hook and tmux mode it does not ask the agent to run a background listener.
  `hoptell doctor` shows the setting and hook sessions running on this machine.
- tmux delivery types a fixed notice instead of the message text, and only when the agent's
  whole input is recognizably empty, no approval prompt is visible, the pane is not in copy
  mode and nobody attached has typed for a few seconds. Messages stay in the inbox until the
  agent reads them. Several waiting messages get one notice; unread ones are announced again a
  few times, at growing intervals, then not again. `hoptell tmux` refuses other
  `HOPTELL_PUSH` values and hoptell channel flags.
- The MCP instructions now fit within what Claude Code reads; longer guidance moved into the
  tool descriptions.
- README: what to do when a Claude Code session does not wake up.

## 0.1.1 (2026-10-06)

- Messages sent with `hoptell send` under a name that no agent used at the time are marked
  "sent from the command line; no reply destination was registered when sent", and the
  tmux injector tells the agent to check `list_peers` before replying, instead of
  suggesting a reply that would fail.
- README: demo recordings of a review handoff and a question to a PM's agent; the
  wake-up summary now describes the channel notice.

## 0.1.0 (2026-10-06)

First public version.

- Relay: a WebSocket hub with a shared token or per-member tokens (a member token allows
  the member's name and `<member>-...` aliases; overlapping names and non-string tokens
  are refused), offline queues, delivery acknowledgements with requeue on disconnect,
  `@role` / `@all` fan-out, a per-connection rate limit, at most 50 unconfirmed messages
  per receiver, `/healthz` and a protocol version check. Malformed traffic cannot crash it.
- MCP server: `list_peers`, `send_message`, `wait_for_message`, `read_inbox`. Every
  incoming message is stored in a private local inbox before it is acknowledged. In
  Claude Code with channels enabled, a channel notice wakes the agent, which reads the
  message with `read_inbox`; elsewhere a background listener or polling picks it up.
- `hoptell tmux`: runs Codex or any terminal agent in tmux and pastes incoming messages
  into exactly its pane while the original process runs there. It holds back while an
  approval prompt is on screen, and a message that itself looks like a prompt is left
  for `read_inbox` instead of being typed.
- CLI: `relay`, `mcp`, `tmux`, `list`, `send`, `wait`, `listen`.
- Tested with Claude Code, Codex and Antigravity (`agy`).
- Distribution: npm package `hoptell`, a Claude Code plugin and marketplace
  (`/plugin marketplace add EminUZUN/hoptell`, then `/plugin install hoptell@hoptell`;
  relay settings through `userConfig`), the relay image `ghcr.io/eminuzun/hoptell`
  (amd64 and arm64) and an MCP Registry entry (`io.github.EminUZUN/hoptell`).
- Releases: a version tag stages the npm version for a maintainer's approval
  (`npm stage publish`, trusted publishing), then publishes the relay image, the MCP
  Registry entry and a GitHub Release from this changelog. No publishing secrets are
  stored, and a failed release can be re-run safely.
- `npm run test:e2e`: optional tests with real Claude Code, Codex and Antigravity agents
  in two Docker containers, checking broadcasts and message passing through every agent.
  They run locally; CI runs the automated suite on Linux with Node.js 20 and 22.
- Dockerfile, Docker Compose and systemd examples that publish the relay on one private
  or VPN address; CI for GitHub and GitLab; ESLint.
