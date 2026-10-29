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

export const TEXTS = {
  // ---- pairing and help (A1-A4) ----
  paired: "You're connected. Your agents can now ask you questions here, and you can message them.",
  help: [
    "How this works:",
    "• A question from an agent: tap an answer, or reply to it.",
    "• To message an agent: just type your message, then pick who it's for. Or use /msg.",
    "• Reply to a recent agent note to continue the conversation. One-off notes don't accept replies.",
    "• /pending shows questions waiting for you. /agents shows your agents and favourites. /team shows your agent teams.",
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
  teamsNone: "No teams yet. A team shows up here once its lead's session reports it.",
  teamsNeedUpdate: "I can't show your teams: the hoptell server needs an update.",
  teamHead: (team, lead, status) => `👥 Team ${team} · led by ${lead}${status === "up" ? "" : ` (${status})`}`,
  teamLine: (who, role, cli, model, effort, branch, state) => `• ${who} · ${role} · ${cli}, model ${model}, effort ${effort} (at launch)${branch ? ` · ${branch}` : ""} · ${state}`,
  teamMore: (n) => `+ ${n} more not shown`,
  teamReview: (who, waiting) => `🔎 Review of ${who}'s work: waiting for ${waiting}`,
  teamsReadOnly: "This view is read-only. The teams report it themselves.",
  cliDefault: "CLI default",

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
