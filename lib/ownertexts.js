// Every text the owner channel's bot shows the owner in Telegram (design 7.3, section 1), in one
// place so the wording can change without touching the bridge's logic. Plain text only (sent
// without parse_mode). `who` is an agent's label (the display rule: its logical name, never the
// relay alias); `n` is a question's number for people (display only, never parsed back).
//
// Rules for every text here: no relay alias, no wire-name prefix, no reference, hash, UUID or
// timestamp, and none of the words relay, member, envelope, instruction, pairing or digest
// (test/ownerchannel-texts.test.js checks each one).

const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "just now", "1 minute ago", "12 minutes ago", "3 hours ago", "2 days ago". */
export function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

/** Why an answer to a prompt card was not (or not fully) pressed, by the injector's reason code. */
export const PROMPT_WHY = {
  late: "the answer reached the Mac too late",
  changed: "the prompt on the Mac was no longer the same",
  busy: "someone was typing or scrolling in that terminal",
  gone: "the session or its terminal was gone",
  storage: "hoptell could not save its state on the Mac",
  tmux: "tmux did not confirm the key",
  interrupted: "hoptell stopped while pressing it",
};

/** What a waiting session waits on, by the prompt subtype its injector saw (lib/prompts.js). */
export const WAIT_WHAT = Object.freeze({
  "codex-startup-trust": "Codex folder trust",
  "folder-trust": "folder trust",
  approval: "an approval",
  login: "a sign-in",
  update: "an update prompt",
  "hook-trust": "hook trust",
  "mcp-trust": "MCP server trust",
  "unknown-dialog": "a question on its screen",
});

export const TEXTS = {
  // ---- pairing and help (A1-A4) ----
  paired: "You're connected. Your agents can now ask you questions here, and you can message them.",
  help: [
    "How this works:",
    "• A question from an agent: tap an answer, or reply to it.",
    "• To message an agent: just type your message, then pick who it's for. Or use /msg.",
    "• Reply to a recent agent note to continue the conversation. One-off notes don't accept replies.",
    "• /pending shows questions waiting for you. /agents shows your agents and favourites. /team shows your agent teams.",
    "• /autoland turns auto-land on for a team that asked you to land something, for 2 h. /autoland off turns it off on every Mac.",
    "Your messages go only to your own agents and guide their work. They don't approve permission requests or changes to hoptell settings.",
  ].join("\n"),
  unknownCommand: (cmd) => `I don't know /${cmd}. Tap the menu button or send /help.`,

  // ---- question cards (B1-B7) ----
  card: (n, who) => `❓ Question ${n} · ${who} asks:`,
  cardResent: (n, who) => `❓ Question ${n} · ${who}\nSent again: the first copy may not have arrived.`,
  cardRepaired: (n, who) => `❓ Question ${n} · ${who}\nSent again in this chat.`,
  cardReplyHint: "Reply to this message to answer.",
  answeredChoice: (n, who, question, choice) => `✅ Question ${n} · ${who} asked:\n${question}\n\nYou chose: ${choice}`,
  answeredReply: (n, who, question) => `✅ Question ${n} · ${who} asked:\n${question}\n\nAnswered (your reply is below).`,
  expired: (n, who, question) => `⌛ Question ${n} · ${who} · Closed\n${question}\n\nThe answer deadline passed. Reply to start a new message.`,
  undelivered: (n, who, question, reason) => `⚠️ Question ${n} · ${who} asked:\n${question}\n\nYour answer could not be delivered: ${reason}.`,
  cancelled: (n, who) => `🚫 Question ${n} · ${who}: cancelled because the Telegram connection was reset.`,
  olderCopy: "↩️ This question was sent again. Please answer the newest copy.",
  noLongerOpen: "This question is no longer open.",
  statusExpired: "This question has expired.",
  statusCancelled: "This question was cancelled.",
  statusUndelivered: "Your answer couldn't be delivered, so this question is closed.",
  alreadyAnswered: "Already answered.",
  sentAck: "✅ Sent.",
  shownTooOften: "I've already sent this question again. Please reply to the newest copy.",
  answerPlaceholder: "Your answer",

  // ---- agent teams (/team, design 8, 3.2): read-only ----
  teamsNone: "No teams to show. A team shows up here while its lead session is online.",
  teamsNeedUpdate: "I can't show your teams: the hoptell server needs an update.",
  teamHead: (team, lead, status) => `👥 Team ${team} · led by ${lead}${status === "up" ? "" : ` (${status === "partial" ? "partly started" : status})`}`,
  // model and effort only when the launch set them.
  teamLine: (who, role, cli, model, effort, state) => `• ${who} · ${role} · ${cli}${model === null ? "" : ` · model ${model}`}${effort === null ? "" : ` · effort ${effort}`} · ${state}`,
  teamMore: (n) => `+ ${n} more not shown`,
  teamReview: (who, waiting) => `🔎 Review of ${who}'s work: waiting for ${waiting}`,
  teamsReadOnly: "Read-only. Each team is shown as its lead session reports it; model and effort as set at launch.",

  // ---- targeting (C1, C4-C17) ----
  prompt: (who) => `✏️ Message to ${who}. Write it below.`,
  promptPlaceholder: (who) => `Message to ${who}`,
  listEmpty: "No agents yet. They show up here once they connect.",
  pickAgent: "Who should get your message?",
  noneOnline: "None of your agents is online right now. To leave a message for one, write @name and your message; it waits until the agent is back.",
  cannotList: "I can't list your agents: the hoptell server needs an update. You can still write @name followed by your message.",
  sentTo: (who) => `✅ Sent to ${who}.`,
  confirmAnswered: (who) => `This question is already answered. Send your text to ${who} as a new message?`,
  confirmExpired: (who) => `This question has expired. Send your text to ${who} as a new message?`,
  confirmClosed: (who) => `This question is closed. Send your text to ${who} as a new message?`,
  confirmButton: (who) => `Send to ${who}`,
  cancelButton: "Cancel",
  cancelledNothingSent: "Cancelled. Nothing was sent.",
  listOld: "This list is old. Open a new one with /msg.",
  buttonExpired: "This button has expired.",
  earlierSetup: "This message or button is from an earlier connection. Use /pending for questions or /msg to choose an agent.",
  lostTrack: "I can't tell who that message was for. To answer a question, use /pending; to write to an agent, use /msg.",
  replyNotSent: (statusText) => `${statusText} Your reply was not sent.`,
  ambiguous: (cmd) => `/${cmd} fits more than one agent right now. Pick one with /msg.`,
  serverUnreachable: "I couldn't reach the hoptell server just now. Please try again in a moment.",
  oneAgent: "Messages go to one agent at a time. Write @name and your message, or use /msg.",
  unknownAgent: (name) => `I don't know an agent called "${name}".`,
  aliasHint: (name, full) => `I don't know an agent called "${name}". Did you mean ${full}? Use /msg.`,

  // ---- the session picker, details, names (design 7.3, 2.1-2.4, 2.8) ----
  agentsHeader: (favs, online) => `Your agents: ${favs} favourite${favs === 1 ? "" : "s"}, ${online} online.`,
  whoIsThisFor: "Who is this for?",
  favouritesBelow: "Your favourites are below.",
  away: (label) => `${label} (away)`,
  moreButton: "More…",
  searchButton: "🔍 Search",
  searchPrompt: "Type part of a name.",
  searchNone: (q) => `No agent matches "${q}".`,
  detailOnline: "🟢 Online",
  detailAway: "⚪ Away",
  detailHost: (host) => ` · on ${host}`,
  detailTalked: (when) => ` · last message ${when}`,
  detailNotTalked: " · no messages yet",
  detailHidden: "🙈 Hidden from lists and favourites; new notes are skipped and won't appear later. Questions still arrive.",
  detailMoved: "⚠️ This agent reports a different computer.",
  messageButton: "✉️ Message",
  favButton: "☆ Add favourite",
  unfavButton: "★ Remove favourite",
  renameButton: "✏️ Rename",
  hideButton: "🙈 Hide and skip notes",
  unhideButton: "👁️ Show agent",
  renamePrompt: (n) => `New name for ${n} (up to 24 characters). Send "-" to remove the name.`,
  aliasTaken: "That name is already used by another agent. Pick another.",
  aliasInvalid: 'Names can be 1 to 24 characters and can\'t start with @, / or an emoji, or contain "·". Pick another.',
  saved: "Saved.",
  notSaved: "I couldn't save that just now. Please try again in a moment.",
  peopleFull: "Your saved-agent list is full. Clear one agent's custom name, favourite and hidden status. Space may take 24 hours to become available.",
  hostMoved: (full, now, was) => `⚠️ ${full} reports running on ${now} (previously ${was}).\nSend once, or remember this computer?`,
  sendButton: "Send once",
  sendRememberButton: "Remember & send",

  // ---- /pending (C18) ----
  pendingHeader: "⏳ Waiting for you:",
  pendingLine: (n, who, excerpt, when) => `• Question ${n} · ${who}: "${excerpt}" (${when})`,
  pendingPage: (page, pages) => `Page ${page} of ${pages}.`,
  pendingNone: "No questions are waiting for you.",
  pendingOld: "This list is old. Send /pending for a new one.",
  showButton: (n) => `Show question ${n}`,
  backButton: "◀ Back",
  nextButton: "Next ▶",

  // ---- notes from agents (section 3) ----
  notice: (who) => `💬 ${who}:`,
  noticeResent: (who) => `💬 ${who} (sent again):`,
  noticeOneWay: (who) => `💬 ${who} (you can't reply to this one):`,
  noticeFlood: (who) => `⚠️ ${who} has reached its message limit. New notes are skipped until the limit clears and won't appear later. Questions still arrive.`,
  noticeFloodAll: "⚠️ The hourly limit for agent notes has been reached. New notes are skipped until the limit clears and won't appear later. Questions still arrive.",

  // ---- the app (design 7.4) ----
  appButton: "📱 Open the app",
  appOpen: "Your agents, favourites and questions, in one place:",
  appOff: "The app is off. Stop the bot, run hoptell telegram app --on on its computer, then start the bot again and send /app here.",
  appNotServed: "The app is on, but the hoptell server can't serve it right now. Ask the server operator to check that the app is enabled and the bot is connected.",
  appUsage: "Use /app to open the app, or /app off to turn it off.",
  appTurnedOff: "The app is turned off. Its links no longer work.",
  appNoUrl: "The app is on, but this bot has no usable HTTPS address for it. Set HOPTELL_APP_URL in the bot's environment to your hoptell server's public HTTPS address, then restart the bot.",
  appDraft: (full) => `✏️ From the app, to ${full}:`,
  appSetFav: (full) => `From the app: ${full} is a favourite and is shown in your lists.`,
  appSetUnfav: (full) => `From the app: ${full} is no longer a favourite.`,
  appSetHidden: (full) => `🙈 From the app: ${full} is hidden from lists and favourites; new notes are skipped and won't appear later. Questions still arrive.`,
  appSetShown: (full) => `From the app: ${full} is shown again. New notes can appear here.`,
  appSetAlias: (plain, alias) => `From the app: ${plain} is now called ${alias}.`,
  appSetNoAlias: (full) => `From the app: ${full} no longer has a custom name.`,
  appNotChangedOff: "Not changed: the app was turned off.",
  appNotChangedLink: "Not changed: the app link was changed.",
  appNotChangedAgain: "Not changed: a newer change was made to this setting.",
  appNotChangedTaken: "Not changed: that name is now used by another agent.",
  appNotChangedFull: "Not changed: your saved-agent list is full. Clear one agent's custom name, favourite and hidden status. Space may take 24 hours to become available.",
  appDraftExpired: "Not sent: this draft expired.",
  undoButton: "Undo",
  undone: "Undone.",
  undoChanged: "I couldn't undo this because the setting changed again. Open the app to check.",
  tapAgain: "Just a moment, then tap again.",
  appMoved: (full, now, was) => `${full} reports a different computer: ${now} (previously ${was}).`,
  appNotYours: (who) => `${who} is no longer one of your agents.`,
  appTooManyDrafts: "You already have 3 drafts waiting in the chat. Send or cancel one first.",
  appLockout: "⚠️ Repeated attempts to open your hoptell app failed. If this wasn't you, send /app off.",

  // ---- landing requests (design 8 addendum, option 3) ----
  landingCard: (id, who) => `🛬 Landing ${id} · ${who} asks you to decide:`,
  landingCardResent: (id, who) => `🛬 Landing ${id} · ${who}\nSent again: the first copy may not have arrived.`,
  landingWhat: (who, subject) => `${who}: ${subject}`,
  landingWhereCheckout: (target, repo) => `→ ${target} in ${repo}, checked out there (fast-forwarded)`,
  landingWhereLinked: (target, repo, checkout) => `→ ${target} in ${repo}, checked out in ${checkout}, a separate checkout (fast-forwarded)`,
  landingWhereBranch: (target, repo) => `→ ${target} in ${repo} (branch only, not checked out)`,
  landingRepoIn: (name, parent) => `${name} (in ${parent})`,
  landingTests: (result, n) => `Tests: ${result === "pass" ? "pass" : "FAILED"} (${n} command${n === 1 ? "" : "s"}, as the lead reports)`,
  landingReview: (verdicts) => `Review: ${verdicts}`,
  landingNoVerdicts: "no verdicts",
  landingClaims: "The test result and the review come from agents: they are claims, not proof.",
  landingTooLarge: "The diff is too large to show here; review it on the Mac.",
  landingDeadline: (at) => `Decide by ${at}. Land moves the branch as shown; Reject moves nothing.`,
  landButton: (id) => `Land ${id}`,
  rejectButton: "Reject",
  diffButton: "Show diff",
  landingChoseLand: (id, who, summary) => `✅ Landing ${id} · ${who}\n${summary}\n\nYou chose: Land. ${who} carries it out now and reports back here.`,
  landingChoseReject: (id, who, summary) => `🚫 Landing ${id} · ${who}\n${summary}\n\nYou chose: Reject. Nothing is moved.`,
  landingDecidedElsewhere: (id, who, summary) => `🛬 Landing ${id} · ${who}\n${summary}\n\nDecided on the Mac.`,
  landingExpired: (id, who, summary) => `⌛ Landing ${id} · ${who} · Closed\n${summary}\n\nThe deadline passed. Nothing was moved.`,
  landingUndelivered: (id, who, summary, reason) => `⚠️ Landing ${id} · ${who}\n${summary}\n\nYour decision could not be delivered: ${reason}. Nothing was moved.`,
  landingCancelled: (id, who) => `🚫 Landing ${id} · ${who}: cancelled because the Telegram connection was reset. Nothing was moved.`,
  landingSentLand: "✅ Sent: land.",
  landingSentReject: "Sent: reject.",
  landingExpiredAck: "This landing request has expired; nothing was moved.",
  landingDecided: "This landing was already decided.",
  landingUseButtons: "Use the Land or Reject button on the card to decide this landing.",
  landingDiffOld: "This diff can no longer be shown.",
  landingDiffName: (id) => `${id}.patch`,
  landingOutcome: (id, state, target) =>
    state === "landed" ? `✅ ${id} landed on ${target}.` : state === "blocked" ? `⚠️ ${id} is blocked; check its state on the Mac.` : state === "rejected" ? `🚫 ${id} was rejected; nothing was moved.` : `⌛ ${id} expired; nothing was moved.`,

  // ---- auto-land (design 8 addendum, option 6) ----
  landAutoButton: (team) => `Land this and auto-land ${team} for 2 h`,
  landingNotAuto: (why) => `Why it wasn't auto-landed: ${why}.`,
  landingChoseLandAuto: (id, who, summary, team) => `✅ Landing ${id} · ${who}\n${summary}\n\nYou chose: Land, and auto-land ${team} for 2 h. ${who} carries it out now and reports back here.`,
  landingSentLandAuto: "✅ Sent: land, and auto-land for 2 h.",
  autolandOn: (team, targets, left) => `🤖 Auto-land on: team ${team}, ${targets}, ${left}.`,
  autolandRefused: (team, why) => `⚠️ Auto-land for team ${team} not turned on: ${why}; give it again from a newer card or in a terminal.`,
  autolandOff: (lead, teams) => (teams ? `✅ Auto-land is off for every team on the Mac of ${lead} (${teams}).` : `✅ Auto-land is off on the Mac of ${lead} (it runs no team).`),
  autolandOffPending: (n) => `⏳ Revocation pending: auto-land turns off on each Mac that asked you to land something (${n} lead session${n === 1 ? "" : "s"}) once it confirms here. A Mac that is offline sees it only once it is back.`,
  autolandOffNone: "No landing request was seen here, so there is nothing to reach; in a terminal: hoptell team autoland <team> --off",
  autolandOffUnsent: (why) => `⚠️ Auto-land could not be turned off on one Mac: ${why.replace(/^(⚠️ )?Not sent: /, "")} In a terminal there: hoptell team autoland <team> --off`,
  autolandNone: "No team asked you to land something here in the last 24 hours, so there is none to offer. In a terminal: hoptell team autoland <team> --target <branch>",
  autolandUsage: "Send /autoland to turn auto-land on for a team, or /autoland off to turn it off.",
  autolandOffer: (team, repo, targets) => `🤖 Auto-land for team ${team} in ${repo}?\nBranches: ${targets}\nFor 2 h, with no limit on the number of landings: the lead lands reviewed and tested work without asking you. The reviewers' verdicts and the lead's test report come from agents.`,
  autolandGrantButton: "Grant for 2 h",
  autolandGrantSent: (team) => `🤖 Sent: auto-land for team ${team}, 2 h. The Mac confirms it here.`,
  autolandOfferChanged: "This team changed since this was shown; check the new offer and tap again.",
  autolandOffUntracked: "Too many recent /autoland off here: the Macs' confirmations of this one will not be shown; it is sent all the same.",
  autolandOffUnsure: "This may not reach every Mac you gave auto-land to: in a terminal there, hoptell team autoland <team> --off",
  autolandOfferGone: "This team's last request is more than 24 hours old; nothing was sent. Send /autoland again.",
  autolandUnsent: (why) => `⚠️ Auto-land was not turned on: ${why.replace(/^(⚠️ )?Not sent: /, "")}`,
  autolandNotice: (id, team, target, state, left) =>
    state === "landed"
      ? `🤖 ${id} landed on ${target} under your auto-land for team ${team}${left ? ` (${left} left)` : ""}.`
      : state === "blocked"
        ? `⚠️ ${id} (auto-land, team ${team}) is blocked; check its state on the Mac.`
        : state === "rejected"
          ? `🚫 ${id} (auto-land, team ${team}) was stopped before it moved; nothing was moved.`
          : `⌛ ${id} (auto-land, team ${team}) expired; nothing was moved.`,

  // ---- a session waits (design 9, B): from its injector, worded here, never screen text ----
  // The session, team and folder are what the note claims; the bridge cannot check them.
  waitPrompt: (who, what, team, folder) => `⏳ A session on your Mac reports that ${who} is waiting for you: ${what}${team ? ` (team ${team})` : ""}${folder ? `, in ${folder}` : ""}.\n${team ? "Open its terminal on the Mac: hoptell team status shows how." : "Open its terminal on the Mac to answer it."}`,
  waitStall: (who, minutes, team, folder) => `⏳ A session on your Mac reports that ${who} has shown no change for ${minutes} min${team ? ` (team ${team})` : ""}${folder ? `, in ${folder}` : ""}. It may be stuck.\n${team ? "Open its terminal on the Mac: hoptell team status shows how." : "Open its terminal on the Mac to check it."}`,
  waitSummary: "⏳ More sessions are waiting. I'll hold further notes like this for an hour; hoptell team status on the Mac shows them.",

  // ---- a waiting session's startup prompt (design 9, C): Codex folder trust, from its injector ----
  promptCard: (who, folder, team) => `🔐 A session on your Mac reports that ${who} is waiting: Codex asks whether to trust the folder ${folder}${team ? ` (team ${team})` : ""}.`,
  promptCardResent: (who, folder, team) => `🔐 Sent again: a session on your Mac reports that ${who} is waiting: Codex asks whether to trust the folder ${folder}${team ? ` (team ${team})` : ""}.`,
  promptWarning: "Trusting lets Codex use this repository's project config and MCP servers.",
  promptUntested: "Test mode: these keys are not yet checked live.",
  promptDeadline: (at) => `Answer by ${at}. hoptell presses only the key you choose, and only while the prompt on the Mac is still the same.`,
  promptChose: (who, folder, label) => `🔐 ${who} · ${folder}\n\nYou chose: ${label}. hoptell presses it on the Mac and reports back here.`,
  promptExpired: (who, folder) => `⌛ ${who} · ${folder} · Closed\n\nThe 10 minutes passed. Nothing was pressed; open its terminal on the Mac to answer it.`,
  promptUndelivered: (who, folder, reason) => `⚠️ ${who} · ${folder}\n\nYour answer could not be delivered: ${reason}. Nothing was pressed.`,
  promptSent: (label) => `Sent: ${label}.`,
  promptExpiredAck: "This prompt card has expired; nothing was pressed.",
  promptDecided: "This prompt was already answered.",
  promptUseButtons: "Use a button on the card to answer this prompt.",
  promptPending: (folder) => `Codex asks whether to trust the folder ${folder}`,
  promptCancelled: (who, folder) => `🚫 ${who} · ${folder}: cancelled because the Telegram connection was reset. Nothing was pressed.`,
  // What became of the owner's answer, as the session's injector reports it (lib/promptexec.js).
  promptDone: (who, folder, label) => `✅ ${who} · ${folder}\n\nYou chose: ${label}. hoptell pressed it on the Mac.`,
  promptRefused: (who, folder, label, why) => `⚠️ ${who} · ${folder}\n\nYou chose: ${label}. Nothing was pressed: ${PROMPT_WHY[why] ?? PROMPT_WHY.changed}. Open its terminal on the Mac to answer it.`,
  promptNoResult: (who, folder, label) => `❓ ${who} · ${folder}\n\nYou chose: ${label}. No result came back from the Mac. Look at its terminal on the Mac.`,
  promptUnknown: (who, folder, label, why) => `❓ ${who} · ${folder}\n\nYou chose: ${label}. hoptell may have pressed part of it: ${PROMPT_WHY[why] ?? PROMPT_WHY.changed}. Look at its terminal on the Mac.`,

  // ---- errors and refusals (E1-E8) ----
  textOnly: "I can only pass on text messages for now.",
  tooLong: (n, max) => `Too long to send: ${thousands(n)} characters, the limit is ${thousands(max)}. Please shorten or split it.`,
  needsUpdate: "Not sent: the hoptell server needs an update before messages can go out.",
  noSuchAgent: (who) => `Not sent: there is no agent called ${who} right now.`,
  notYours: (who) => `Not sent: ${who} is no longer one of your agents.`,
  serverRefused: "Not sent: the hoptell server refused it.",
  encryptionRequired: "⚠️ Not sent: your settings require end-to-end encryption, which this bot chat can't provide. Run hoptell telegram status on the bot's computer for details.",
  encryptionPaused: "⚠️ Messages to your agents are paused: your settings require end-to-end encryption, which this bot chat can't provide. Run hoptell telegram status on the bot's computer for details.",
};

/**
 * Why an answer could not be delivered (B5), from the E-table: the refusal's reason without its
 * "Not sent: " lead, ending without a period (B5 adds it).
 */
/** Why a landing request was not auto-landed, by the code the lead's request carries (lib/landings.js AUTO_CODES). */
export const NOT_AUTO_WHY = { tests_failed: "the tests failed", changes: "a reviewer asked for changes", no_reviewers: "no reviewer was asked", not_covered: "your auto-land covers other branches", notices_full: "too many auto-land messages to you are still waiting" };

/** Why the Mac did not keep an auto-land grant, by the code of its report (lib/landings.js AUTOLAND_WHY). */
export const AUTOLAND_REFUSED_WHY = {
  stale: "it was given before auto-land was last turned off",
  expired: "it had expired when the Mac received it",
  scope: "the team was started again or changed since that card",
  no_team: "that Mac no longer runs this team",
  not_lead: "it reached a session that does not lead this team",
  storage: "the Mac could not keep it",
  paused: "that Mac paused auto-land after too many /autoland off in the last days",
};

export const UNDELIVERED_REASONS = {
  relay_without_to_member: () => "the hoptell server needs an update",
  unknown_peer: (who) => `there is no agent called ${who} right now`,
  recipient_member_mismatch: (who) => `${who} is no longer one of your agents`,
  relay_refused: () => "the hoptell server refused it",
  encryption_required: () => "your settings require end-to-end encryption, which this bot chat can't provide",
};

/**
 * The bot's profile texts (design 7.3, section 4), set only by `hoptell telegram identity
 * --apply` after the owner confirms. Limits: name 0-64, short description 0-120, description
 * 0-512 characters.
 */
export const IDENTITY = {
  name: "hoptell",
  short_description: "Your AI agents' questions, on your phone. Answer with a tap, or send them a message.",
  description: [
    "This bot connects you to your own AI agents (Claude Code, Codex and others) through hoptell.",
    "",
    "Your agents ask you questions here; answer with a tap or a reply. You can also message any of your agents, from any of your machines.",
    "",
    "This bot only works for the person who set it up. If that isn't you, it won't answer.",
  ].join("\n"),
};
export const IDENTITY_LIMITS = { name: 64, short_description: 120, description: 512 };
