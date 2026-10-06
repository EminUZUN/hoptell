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
status and queued-message counts. Message text is routed to the addressed peers. On supported
systems, the MCP server also reads up to five ancestor processes' IDs and command lines locally
to detect channel support; these command lines are not sent to the relay.

## The relay

- Messages travel to and from the relay over WebSocket. The relay has no built-in TLS, so
  run it on a private network or VPN, or behind a TLS proxy (`wss://`).
- The relay holds queued messages, deliveries awaiting confirmation and peer metadata in
  process memory; it does not persist that state to disk. New queue admissions are limited to
  50 messages per peer and 2,000 overall, with up to 50 additional deliveries awaiting
  confirmation per peer. Requeueing previously accepted, unconfirmed deliveries can exceed the
  normal queue limits.
- The relay stops retaining a message when the receiving client confirms receipt. This
  confirms local storage or output, not that an agent read or acted on it. Restarting the
  relay discards its message and peer state. Queued messages have no time-based expiry.
  Periodic cleanup removes a peer only when it is offline, has no queued messages and was
  last seen more than six hours ago.
- The relay's default logger writes timestamps, connection and routing metadata,
  authentication failures, and socket or internal error descriptions to standard output.
  Metadata includes peer names, roles, host labels, IP addresses and, for some routing events,
  message lengths in characters. Logging calls do not explicitly include the message-text or
  authentication-token fields. The operator controls where output is stored and how long it
  is kept.

## Each machine

- The MCP server stores incoming messages as local JSON files before confirming receipt. The
  default inbox is `~/.hoptell/inbox/<peer name>/`, or `$HOPTELL_HOME/inbox/<peer name>/` when
  configured. hoptell creates directories with Unix mode 0700 and files with mode 0600; access
  is subject to the operating system, including administrator privileges.
- Message files are consumed and deleted by `read_inbox`, `wait_for_message`, or
  `hoptell listen`, or after submission through the tmux injector. Consumption does not confirm
  that an agent processed the message. Pending files have no automatic expiry. The standalone
  `hoptell wait` command prints received messages directly to standard output instead of
  storing them in the inbox.
- `hoptell tmux` writes the relay URL, token and any configured push setting to
  `~/.hoptell/sessions/<name>.env` (under `$HOPTELL_HOME` when configured). The file is not
  encrypted by hoptell and is created with Unix mode 0600 in private directories. It remains
  after the session ends, until you delete it or launch another session with the same name.
- The plugin's sensitive relay-token setting is stored in Claude Code's secure credential
  storage. Other settings may be stored differently by Claude Code. hoptell also reads
  environment variables and the first applicable settings file: `HOPTELL_ENV` if specified;
  otherwise `$XDG_CONFIG_HOME/hoptell/.env` (default `~/.config/hoptell/.env`) or the
  package's `.env`. Non-empty environment variables take precedence. Tokens in these files are
  not encrypted by hoptell.

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
