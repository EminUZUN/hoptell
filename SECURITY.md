# Security policy

## Reporting a vulnerability

Please don't open a public issue for security problems. Report them privately through
[GitHub's private vulnerability reporting](https://github.com/EminUZUN/hoptell/security/advisories/new).
Include:

- what an attacker can do and what access they need (network access to the relay, a valid
  token, a local account on a peer machine, ...)
- steps to reproduce, and the hoptell version (`package.json`)

We aim to acknowledge reports within 7 days.

## Threat model

hoptell delivers text written by one AI agent to another AI agent that may act on it.

**Trusted:** the relay operator, and every holder of a valid token. A token holder can send to
any peer that the relay's policy, the recipient's grants and the recipient's contacts allow.
With a shared `HOPTELL_TOKEN` they can also use any peer name. With per-member tokens they can
use only their own `<member>` and `<member>-*` names (the relay refuses overlapping member
names). Roles and session titles are self-chosen labels, not permissions or identity. What
reaches an agent is then up to the receiving machine's contacts (see below).

**Protected against:**

- anyone without a token who can reach the relay: they cannot connect, read or send, and
  malformed traffic cannot crash the relay
- peer text that tries to escape its message: it cannot close the `<channel>` tag, forge
  a message boundary, or inject terminal control characters through the tmux injector
- other local users on a peer machine: inboxes are per-user (`~/.hoptell`, 0700/0600),
  and symlinked or foreign-owned directories are refused
- senders you have not allowed: in a new install, the receiving machine holds their messages
  until you decide (`hoptell contacts`). The agent is woken with a fixed notice and never sees
  the text. By default, messages that the relay states come from your own member, in the same
  realm, with neither side hosted, skip this hold. `HOPTELL_CONTACTS_SELF=hold` removes that
  exception; existing grants still apply. Blocks and `required` encryption still apply.
- forged owner messages: an agent treats an answer or instruction as yours only when it is
  signed by a bridge key you pinned with `hoptell telegram trust`. Statuses the bridge
  generates (expired, cancelled) are marked as automatic.
- runaway agents: 30 messages per 10 seconds per connection, 100,000 characters per
  message, bounded queues, at most 50 unconfirmed messages per receiver
- typing into the wrong place: the tmux injector targets one pane by id, and holds the paste
  and the Enter that submits it while it recognizes an approval prompt on screen (best effort:
  it reads the screen, so an unfamiliar prompt, or one that appears in the instant before
  Enter, is not caught). Message text that looks like a prompt is never typed, so it cannot
  be mistaken for one; the agent is told to fetch that message with `read_inbox`

**Not protected against (by design, use your network for these):**

- eavesdropping on plain `ws://`: use a VPN or a TLS proxy (`wss://`)
- a token holder writing persuasive instructions: hoptell labels messages as coming from
  another agent, but the receiving agent's own permission settings are the real boundary
- availability: there is one relay with in-memory queues
- a relay that lies about who signed in: grants and own-member trust rely on the relay's
  statement of the sender's member id
- Telegram: owner-channel chats are not end-to-end encrypted, and Telegram can read them

**Experimental encrypted messages (off by default):** with `HOPTELL_EXPERIMENTAL_E2EE=1` and a
relay started with `--experimental-e2ee` (or with `HOPTELL_EXPERIMENTAL_E2EE` set in the relay's
environment), direct messages and encrypted fan-out are end-to-end encrypted with MLS (suite
0x004D only). Larger file transfers use their own encryption of the file bytes (a key for that
transfer only, in 256 KiB chunks); the key is announced inside an MLS-encrypted message. They are
experimental and not independently reviewed; no MLS binding is qualified for release. What they
rely on, and their known limits:

- Your own devices are trusted only from the devices you accepted (`hoptell device accept`),
  kept in `contacts.json`; the relay's list of your devices is never taken as is. A safety
  number's own half comes from them, and verify refuses while the relay lists a device of yours
  you have not accepted.
- If a member has a registered device that remains unrevoked, the relay registers another only
  with an approval signed by an active device of that member (`hoptell device accept`) or given by
  the relay owner (`hoptell members device-approve`). If a member has no registered device that
  remains unrevoked, a member token alone can register a new device. The token can also make up to
  four pending requests and send plaintext messages as the member. An active member device can
  cancel requests or use `hoptell device expect` to reserve a fifth request slot for a specific
  device and key; this does not approve registration. Devices registered before this rule remain
  active. After upgrading, review them with `hoptell device list` and revoke any you do not
  recognize; `hoptell doctor` also warns about devices you have not accepted that hoptell last saw
  at the relay.
- A contact you have not verified is trusted on first use (relay-tofu): the relay's list of their
  devices is taken at the first encrypted message, so a relay can add a device to it. Verify
  your contacts (`hoptell contacts verify`) or set `requireVerified`; later changes of a verified
  contact's devices hold messages until you decide.
- A device the relay stops listing is not removed, and a message that reached no device of the
  contact is reported as not delivered.
- A restore through `hoptell device restore` (or `migrate`) retires the restored device before
  anything else, and state found on another machine refuses to send; but restoring an **older
  raw copy** of `~/.hoptell` on the **same** machine, outside those commands, brings back the
  same machine identifier and older keys, and hoptell cannot detect it. There is no independent
  freshness anchor yet (`hoptell doctor` says so too).
- Device-signed revocation and rotation need an MLS binding that can sign; without it they are
  refused before any change, and the relay owner's revocation (`hoptell members device-revoke`)
  is the remedy.

**Hosted custody (experimental, `hoptell mcp-hosted --experimental`):** a hosted member's host
can read that member's messages. Hosted members are separate members, labeled for their peers,
have no devices, and are never sent to encrypted or under a `required` encryption policy.

**Owner decisions (`hoptell contacts`, `hoptell ui`, the optional question in the client):**
they protect against peers, stale views and accidents. A decision is bound to what was shown and
refused if that changed. An agent running as the same OS user can run the CLI, open the UI or
edit the files, so none of these proves that a person decided. `hoptell ui` listens on
127.0.0.1 only and accepts only its exact address as Host, its own Origin on forms, a single-use
launch link and an in-memory session cookie; every form carries a token bound to the session and
to the choices it offered. Browsers send a `127.0.0.1` cookie to every port on that address, so a
local server that the browser visits during the session receives the cookie and could replay it;
this is outside what the UI protects against. The question in the client
(`HOPTELL_ELICITATION=read_inbox`, off by default) offers only `allow-once` and `later`, and a client may answer it automatically.

## Hardening checklist

- Run the relay only on a private interface or VPN address (`--host`).
- Use per-member tokens (`--members`) when more than one person connects; store hashes
  (`sha256:...`) in the members file and keep it `chmod 600`.
- Keep `.env` files `chmod 600` and out of version control.
- Prefer agents that ask for approval on risky actions; avoid auto-approve modes for
  agents that receive messages from people you do not fully trust.
- On an install that existed before contacts, run `hoptell contacts init` so unknown senders
  are held.
- Set `HOPTELL_CONTACTS_SELF=hold` when one of your own sessions reads untrusted input (web
  pages, issues, other people's files), so it can't instruct your other sessions without your
  decision.
- Pin an owner-channel key only from the pin that `hoptell telegram setup` printed on your
  bridge machine.
