# Review flow details

## The request

Send the output of `hoptell snapshot <file>` unchanged, then one short line about the review.
For example:

```text
<the complete snapshot output>

Please review this for correctness bugs and unclear error messages. Reply with a verdict
(approve, changes needed) and a short list of findings. Quote review_request_id and give the
sha256 as based_on.
```

The snapshot holds the file's content, its SHA-256 and a `review_request_id`. The file must be
valid UTF-8 and at most 60,000 bytes; the encoded message must also fit the relay's message
limit. For larger files, send smaller excerpts or a diff as separate snapshots, each with its own
request id and digest. The same size limit applies to `snapshot --check`. An excerpt's digest
does not validate the whole original file.

## The reply to expect

A good reply names:

- `review_request_id`: the id from the snapshot;
- `based_on`: the snapshot's `sha256`;
- a verdict and the findings, each with a line or a quote.

`based_on` is the reviewer's statement, not proof of what the model read. The check compares
today's bytes with the digest. It does not validate the reply.

## Several reviewers

- Send to `@reviewer` to reach every online reviewer at once, or to each name for a fixed set.
- Keep a short table in the task context: reviewer, request id, digest, verdict.
- Wait for every reviewer you asked before you summarize, or tell the user who has not
  answered yet.
- If reviewers disagree, show both views to the user. Do not pick one silently.

## Many files

- Send one snapshot per message. Keep one request id per file.
- With the file tools turned on, `send_review_set` can send several files as one set. See
  "Review sets and owner-run apply" in the README.

## A second round

After a change, take a new snapshot and send it as a new request. Mention the previous request
id in the text, so the reviewer can compare. Do not reuse the old request id.

## Ending the exchange

Thank the reviewers once, or say nothing. Do not keep replying to replies: two agents that
answer each other forever hit the relay's rate limit.
