# Upstream Discussion Prompt

> **Audience:** you (Redblock), to post on the original project's GitHub.
>
> **What this is:** a ready-to-paste forum post for the **Discussions** tab of
> `pdovhomilja/nextcrm-app`, plus guidance on *why* it's worded this way and on your
> "would we do anything differently to be palatable to upstream?" question.

---

## How to use this

1. Go to the upstream repo → **Discussions** tab → **New discussion** →
   category **"Ideas"** (or "General" / "Q&A" if Ideas doesn't exist).
2. Paste the block under **"📋 Copy-paste post"** below. Lightly adjust the bracketed bits.
3. Post under your own GitHub account. It's fine that you forked without planning to
   contribute — the post says so honestly.
4. If maintainers reply with a preference, bring it back here and we'll reconcile it with
   `DEVELOPMENT_GUIDE.md` before you build more.

A discussion (not an issue) is the right venue: you're asking about direction and coordination,
not reporting a bug or requesting a specific change.

---

## 📋 Copy-paste post

**Title:** Roadmap check: planned Targets/Campaigns or email-marketing features? (coordinating a private fork)

---

Hi, and thank you for NextCRM — it's a genuinely great foundation. 🙏

I maintain a **private fork** for my company. To be upfront: I forked it for our own use and
**don't currently plan to contribute back**, though I'd like to keep the door open in case that
changes — which is exactly why I'm asking before I build more.

We're adding **email-marketing / funnel** functionality on top of the existing
**Targets / Campaigns** area: things like multi-step campaign sequences, scheduled and
follow-up sends, post-purchase automation (we tie some of it to Stripe order data on targets),
target lists, and merge-tag templating.

I'd love to avoid building something that collides with where you're already heading. A few
questions:

1. **Roadmap:** Is there any planned or in-progress work on **Targets, Campaigns, or email
   marketing/automation**? If so, I'd rather align with your direction than diverge.
2. **Data model:** Do you have a preferred way to extend models like `crm_Targets` —
   additional columns, a related side-table, a JSON field, or something else? I want my
   additions to be non-breaking and easy to reconcile with your releases.
3. **Feature structure:** For larger feature areas, is there a structure/convention you'd
   recommend (folders, registration points, naming) so a fork's additions stay tidy and
   mergeable?
4. **Namespacing:** To avoid name clashes with your code, I'm planning to prefix our additions
   with our initials (e.g. an `rb-extensions/` folder, `Rb…` Prisma models, `rb_…` tables).
   Does a vendor-prefix convention like that make sense to you, or do you have a preferred
   approach for fork-specific code?
5. **Contributing path (optional):** If any of this *is* of general interest, what would make a
   feature like this acceptable as a future PR — design notes first, a feature flag, a
   particular shape?

No expectation of support for a private fork — I'm just hoping we can stay roughly on the same
page so future upstream updates remain smooth for us (and so anything we might eventually share
fits your vision). Happy to share more detail on our design if useful.

Thanks again for the project and for any guidance! 🙌

---

## Notes on tone & strategy (not part of the post)

- **Lead with appreciation and honesty.** Saying "private fork, not planning to contribute, but
  keeping the door open" is disarming and accurate — maintainers respond better to candor than
  to a vague feature pitch.
- **Ask, don't propose.** You're surfacing *their* roadmap and preferences, not asking them to
  adopt your design. That keeps the burden on you and the ask light.
- **The Stripe detail is deliberately brief.** It signals real use without dragging the thread
  into your specific implementation.
- **Don't paste secrets, internal URLs, or customer data.** Keep it about shape and direction.

---

## Your meta-question: would we do anything differently to be "palatable" to upstream?

Short answer: **the fork-safety design and the upstream-friendly design pull in opposite
directions, and that's fine — you can keep both options open.**

There's a real tension:

| Goal | Favors… |
|---|---|
| **Easy to maintain as a private fork** | Isolation: an `rb-extensions/` folder, `Rb`/`rb_` namespacing, feature flags. Custom code never touches upstream files. (This is what `MIGRATION_GUIDE.md` / `DEVELOPMENT_GUIDE.md` describe.) |
| **Easy for upstream to accept as a PR** | Integration: code written in *their* conventions, in *their* folders, using *their* `crm_` naming, as a first-class feature — no separate namespace, no "rb-" prefix. |

A maintainer generally **won't merge a folder full of vendor-prefixed code** — from their side it
looks like someone else's app bolted on. So the very thing that makes the fork easy for you to
maintain is the thing that makes it least mergeable.

**The good news:** isolation doesn't lock you out of upstreaming, as long as you build with a
later hand-off in mind. Concretely:

- **Keep the logic clean and framework-native inside `rb-extensions/`.** Write it the way
  upstream would — same patterns, same libraries (Prisma, Inngest, server actions), no exotic
  dependencies. The namespace is a wrapper, not a different architecture.
- **Keep the seams thin and documented.** If a feature only connects to upstream through a couple
  of registration points, "lifting" it into upstream later means de-namespacing and moving files
  — mechanical, not a rewrite.
- **Prefer additive, non-breaking schema changes** (nullable columns, side tables). These are
  exactly what a maintainer can accept without fear, and they're also what keeps your merges
  painless. This is the rare choice that serves *both* goals.
- **Don't over-fit to "rb-" if you think you'll contribute a given feature.** For a feature you
  genuinely intend to upstream someday, consider building it under their conventions from the
  start and proposing a design in Discussions first (question 5 above). Reserve the heavy
  `rb-extensions/` isolation for things that are truly Redblock-specific and will never leave.

So: **decide per feature.** Most of your work is private and should live in `rb-extensions/` for
maintainability. If the maintainers signal interest in something specific, *that* feature can be
re-shaped into their conventions for a PR — and because the logic was written cleanly, that
conversion is cheap. You don't have to choose globally today; you only have to keep the code
clean enough that either path stays open.
