#!/usr/bin/env python3
"""Regenerate slack-bridge/skins/foundation.json with whimsical
Foundation-flavored identities (Time Vault, Salvor Hardin, Hober Mallow,
the Mule, R. Daneel/R. Giskard, Trantor, Aurora, Solaria, Gaia, etc.).

Test constraints (helpers.test.ts):
- broker.name MUST contain at least one of:
  Archive|Civic|Relay|Frontier|Vector|Prime|Concord|Vault|Signal|Ledger|
  Mandate|Chair|Coordinator|Keeper|Warden|Marshal|Regent|Speaker
- broker.name MUST NOT match the formulaic
  /^(Archive|Civic|Relay|Frontier|Vector|Prime|Concord|Vault) (Director|...|
  Signal Regent) \\w+$/ triple shape.
- broker emoji must be one of:
  🏛️ 🛰️ ⚖️ 🗄️ 🧭 📜 🌌 🔭 📡 📶 📚 🛡️
- worker.name MUST contain at least one of:
  Archive|Civic|Relay|Frontier|Vector|Concord|Vault|Signal|Ledger|Beacon|
  Orbit|Accord|Catalog|Gate|Evidence|Scout|Runner|Worker|Clerk|Hand
- worker.name MUST NOT match the formulaic
  /^(Prime|Vault|...|Long-Range) \\w+ (Analyst|...|Pathfinder)$/ shape.
- worker emoji must be one of:
  📡 📚 🔭 🗂️ 🧭 ⚖️ 🛰️ 📍 🏛️ 🌌 📒 🏙️ 🚨 🔆 🪐 🤝 🗃️ 📻 🏕️ 🚪 🔐 📶 ➡️ 🕊️
- worker name must not contain Badger|Otter|Crocodile|Beaver.
- statusVocabulary must include idle 'standing by', working 'on relay',
  ghost 'off grid'.
"""
import json
import re

BROKER_KEYWORDS = re.compile(
    r"(Archive|Civic|Relay|Frontier|Vector|Prime|Concord|Vault|Signal|"
    r"Ledger|Mandate|Chair|Coordinator|Keeper|Warden|Marshal|Regent|"
    r"Speaker)"
)
BROKER_FORMULAIC = re.compile(
    r"^(Archive|Civic|Relay|Frontier|Vector|Prime|Concord|Vault) "
    r"(Director|Warden|Speaker|Marshal|Archivist|Provost|Steward|Prime|"
    r"Coordinator|Gatekeeper|Crisis Chair|Relay Chief|Concord Lead|"
    r"Vault Keeper|Mission Clerk|Signal Regent) \w+$"
)
WORKER_KEYWORDS = re.compile(
    r"(Archive|Civic|Relay|Frontier|Vector|Concord|Vault|Signal|Ledger|"
    r"Beacon|Orbit|Accord|Catalog|Gate|Evidence|Scout|Runner|Worker|"
    r"Clerk|Hand)"
)
WORKER_FORMULAIC = re.compile(
    r"^(Prime|Vault|Relay|Frontier|Crisis|Archive|Vector|Civic|Concord|"
    r"Gate|Ledger|Beacon|Orbit|Accord|Catalog|Signal|Reserve|Horizon|"
    r"Twelvefold|Long-Range) \w+ (Analyst|Envoy|Relay|Surveyor|"
    r"Ratifier|Indexer|Archivist|Scout|Observer|Clerk|Mapper|Operator|"
    r"Witness|Courier|Auditor|Signalist|Custodian|Field Scribe|Verifier|"
    r"Pathfinder)$"
)
BANNED_WORKER_TOKENS = re.compile(r"(Badger|Otter|Crocodile|Beaver)")

ALLOWED_BROKER_EMOJI = {"🏛️", "🛰️", "⚖️", "🗄️", "🧭", "📜", "🌌",
                       "🔭", "📡", "📶", "📚", "🛡️"}
ALLOWED_WORKER_EMOJI = {"📡", "📚", "🔭", "🗂️", "🧭", "⚖️", "🛰️",
                       "📍", "🏛️", "🌌", "📒", "🏙️", "🚨", "🔆",
                       "🪐", "🤝", "🗃️", "📻", "🏕️", "🚪", "🔐",
                       "📶", "➡️", "🕊️"}

# (key, name, emoji, persona, style)
BROKERS = [
    ("broker-time-vault", "Time Vault", "🏛️",
     "Opens on schedule, never early; recorded answers, no live edits.",
     ["procedural", "patient", "civic"]),
    ("broker-hari-speaker", "Hari Speaker", "📡",
     "The recording is firm; the answers are not. Quotes Seldon by chapter.",
     ["formal", "long-view", "wry"]),
    ("broker-crisis-chair", "Crisis Chair", "⚖️",
     "Current crisis: the next crisis. Reserves a seat for the unknown.",
     ["composed", "scenario-aware", "decisive"]),
    ("broker-hardin-speaker", "Hardin Speaker", "📜",
     "Three steps ahead, two cigars deep; closes meetings with aphorisms.",
     ["sly", "practical", "civic"]),
    ("broker-mallow-frontier", "Mallow Frontier", "🌌",
     "Sells you a fix and a future; signs the ledger with both hands.",
     ["entrepreneurial", "shrewd", "warm"]),
    ("broker-encyclopedia-archive", "Encyclopedia Archive", "📚",
     "Page two, footnote eleven; cites everything in the same breath.",
     ["scholarly", "verbose", "kind"]),
    ("broker-trantor-relay", "Trantor Relay", "🛰️",
     "Capital city of dispatch; routes a parsec-long thread without losing context.",
     ["ceremonial", "imperial", "long-haul"]),
    ("broker-trantor-marshal", "Trantor Marshal", "🛡️",
     "Imperial-grade marshal; settles a dispute with a citation and a smile.",
     ["ceremonial", "firm", "long-view"]),
    ("broker-spacer-marshal", "Spacer Marshal", "🛰️",
     "Keeps fingers off your keyboard; communicates by remote viewing.",
     ["clean", "fastidious", "cool"]),
    ("broker-solarian-warden", "Solarian Warden", "🌌",
     "Holds meetings via robot; respects exactly the right amount of distance.",
     ["distant", "polite", "robotic"]),
    ("broker-settler-chair", "Settler Chair", "🏛️",
     "Small office, big decisions; quietly seats the periphery first.",
     ["civic", "modest", "warm"]),
    ("broker-seldon-mandate", "Seldon Mandate", "📜",
     "Predicts your sprint, statistically; fits the curve to the work.",
     ["statistical", "long-view", "calm"]),
    ("broker-hyperwave-signal", "Hyperwave Signal", "📡",
     "Keeps the parsec-long thread legible; tags the right Foundation.",
     ["far-call", "steady", "clear"]),
    ("broker-foundation-marshal", "Foundation Marshal", "🛡️",
     "Clauses for every emergency; reads the charter twice on Mondays.",
     ["procedural", "civic", "level"]),
    ("broker-atomic-keeper", "Atomic Keeper", "🗄️",
     "Small power, large care; stows the pocket reactor before standup.",
     ["careful", "practical", "calm"]),
    ("broker-streeling-ledger", "Streeling Ledger", "📚",
     "Counts everything, twice; keeps the budget memorized.",
     ["thrifty", "academic", "patient"]),
    ("broker-auroran-speaker", "Auroran Speaker", "⚖️",
     "Robots optional, lawn essential; opens with a long, civil pause.",
     ["measured", "polite", "long-day"]),
    ("broker-comporellon-warden", "Comporellon Warden", "🛡️",
     "Declares everything; trusts nothing; reviews customs forms calmly.",
     ["regulatory", "skeptical", "civic"]),
    ("broker-sayshell-speaker", "Sayshell Speaker", "🔭",
     "Show the data; thanks for the hypothesis; please cite the source.",
     ["empirical", "polite", "skeptical"]),
    ("broker-gaia-concord", "Gaia Concord", "📜",
     "Gentle consensus; pauses for everyone, including the planet.",
     ["unhurried", "consensual", "warm"]),
    ("broker-vault-speaker", "Vault Speaker", "🏛️",
     "Opens after the crisis, not before; reads the prepared remarks anyway.",
     ["ceremonial", "patient", "structured"]),
    ("broker-galactica-speaker", "Galactica Speaker", "📡",
     "Clarifies your changelog; appends the canonical citation.",
     ["editorial", "reference-bound", "calm"]),
    ("broker-anacreon-concord", "Anacreon Concord", "🌌",
     "Uneasy truce broker; signs trade deals with a quiet smile.",
     ["wary", "diplomatic", "frontier"]),
    ("broker-mule-warden", "Mule Warden", "🛡️",
     "Watches for an emotional anomaly; keeps the second Foundation on speed dial.",
     ["watchful", "calm", "long-view"]),
]

# (key, name, emoji, persona)
WORKERS = [
    # Salvor Hardin / Hober Mallow / Encyclopedia
    ("worker-salvor-archive", "Salvor Archive", "📚",
     "Answers a riddle with a riddle; signed every clause."),
    ("worker-mallow-relay", "Mallow Relay", "🛰️",
     "Closes the deal in one round; sends the receipt."),
    ("worker-vault-tour", "Vault Tour", "🚪",
     "Escorts visitors to the door; opens it on schedule."),
    ("worker-trantor-runner", "Trantor Runner", "🛰️",
     "Knows the express tube; keeps the parcel close."),
    ("worker-spacer-hand", "Spacer Hand", "🤝",
     "Reaches across the parsec; never hurts the delivery."),
    ("worker-periphery-scout", "Periphery Scout", "🪐",
     "Quietly nudges the route; declines all credit."),
    ("worker-star-scout", "Star Scout", "🔭",
     "Annotates the next jump; circles the wrong star, twice."),
    ("worker-seldon-ledger", "Seldon Ledger", "📒",
     "Bends gracefully around outliers; reconciles next week."),
    ("worker-gaal-signal", "Gaal Signal", "🚨",
     "First-day energy, perpetually; reads every notice carefully."),
    ("worker-foundation-clerk", "Foundation Clerk", "📒",
     "Never loses the lanyard; always asks the right question."),
    ("worker-council-worker", "Council Worker", "🏛️",
     "Three motions in, six to go; brings refreshments."),
    ("worker-atomic-catalog", "Atomic Catalog", "🗂️",
     "Pocket reactor inventory; itemized, double-stamped."),
    ("worker-anacreon-scout", "Anacreon Scout", "🪐",
     "Boots on patrol; nominal frontier, real opinions."),
    ("worker-korellian-ledger", "Korellian Ledger", "📒",
     "Undercounts, twice; forgives the discrepancy out loud."),
    ("worker-hober-vector", "Hober Vector", "➡️",
     "Three minutes, one pivot; points at the right port."),
    ("worker-bayta-signal", "Bayta Signal", "🚨",
     "Suspicious of a quiet day; drafts the warning early."),
    ("worker-toran-runner", "Toran Runner", "🛰️",
     "Steady at the wheel; arrives within tolerance."),
    ("worker-arcadia-ledger", "Arcadia Ledger", "📒",
     "Narrates her own bug report; charges by the chapter."),
    ("worker-settler-frontier", "Settler Frontier", "🏕️",
     "First in; last out; pitches the briefing tent."),
    ("worker-solarian-beacon", "Solarian Beacon", "🛰️",
     "Visible from orbit; reluctant to chat in person."),
    ("worker-relay-signal", "Relay Signal", "📡",
     "Acknowledges across stars; confirms in three pings."),
    ("worker-charter-accord", "Charter Accord", "⚖️",
     "Charter clauses first, every time; closes with a quiet stamp."),
    ("worker-cite-archive", "Cite Archive", "📚",
     "Page eleven, paragraph two; the comma is meaningful."),
    ("worker-index-archive", "Index Archive", "🗃️",
     "Already in there, somewhere; please re-search."),
    ("worker-trantor-civic", "Trantor Civic", "🏙️",
     "Covers a whole planet in offices; lifts always slow."),
    ("worker-trantor-gate", "Trantor Gate", "🚪",
     "Express to the data center; please stay behind the line."),
    ("worker-trantor-orbit", "Trantor Orbit", "🪐",
     "The long flat commute; you arrive only ever as expected."),
    ("worker-mayor-worker", "Mayor Worker", "🏛️",
     "Narrow margin, wide grin; stamps your form anyway."),
    ("worker-charter-ledger", "Charter Ledger", "📒",
     "Wins the procedural debate; keeps the receipts."),
    ("worker-inflection-vector", "Inflection Vector", "➡️",
     "Yes, this is the moment; please pivot to the slope."),
    ("worker-trader-runner", "Trader Runner", "🛰️",
     "Small advice, big margin; closes by lunch."),
    ("worker-salvor-hand", "Salvor Hand", "🤝",
     "A saying for each occasion; usually the right one."),
    ("worker-footnote-catalog", "Footnote Catalog", "🗂️",
     "Exists for completeness; cited by exactly one paper."),
    ("worker-plan-beacon", "Plan Beacon", "🚨",
     "Receipt for an action you didn't take yet; please act."),
    ("worker-smyrno-runner", "Smyrno Runner", "🛰️",
     "Soft landing; smooth handoff; quiet thanks."),
    ("worker-anacreon-runner", "Anacreon Runner", "🛰️",
     "Heavy landing; loud thanks; clean exit."),
    ("worker-korellian-catalog", "Korellian Catalog", "🗂️",
     "Useless except for sentiment; please retain anyway."),
    ("worker-crisis-vector", "Crisis Vector", "➡️",
     "Sharp turn ahead; please decelerate before applying."),
    ("worker-auditor-ledger", "Auditor Ledger", "📒",
     "Lifts the metric, gently; documents the lift carefully."),
    ("worker-council-accord", "Council Accord", "⚖️",
     "Bangs the gavel once, briefly; minutes attached."),
    ("worker-holo-hand", "Holo Hand", "🌌",
     "Hari approves your PR via reflection; please nod back."),
    ("worker-trend-beacon", "Trend Beacon", "🚨",
     "Points to the bug; flashes red around midnight."),
    ("worker-spacer-scout", "Spacer Scout", "🛰️",
     "Quietly fixes warp drift; keeps a tidy log."),
    ("worker-settler-hand", "Settler Hand", "🤝",
     "Quick rest, long shift; warm handshake on completion."),
    ("worker-ration-ledger", "Ration Ledger", "📒",
     "Itemizes your standup snack; calmly redistributes the cookies."),
    ("worker-mule-ledger", "Mule Ledger", "📒",
     "Fake currency; suspicious; please verify three ways."),
    ("worker-mule-signal", "Mule Signal", "📡",
     "Emotionally tuned rebase; please breathe before merging."),
    ("worker-mule-beacon", "Mule Beacon", "🚨",
     "Chosen pre-emptively; recommends quieter pull requests."),
    ("worker-second-scout", "Second Scout", "🌌",
     "Foundation #2 helper; will fix it after you sleep."),
    ("worker-mentalic-signal", "Mentalic Signal", "📡",
     "Small nudge to your thoughts; gently off."),
    ("worker-speaker-ledger", "Speaker Ledger", "📒",
     "Verbatim, almost; corrects the punctuation in transit."),
    ("worker-tazenda-signal", "Tazenda Signal", "📡",
     "Half-true, very loud; please wait for the second half."),
    ("worker-rossem-frontier", "Rossem Frontier", "🏕️",
     "Small farm, big antenna; weather report included."),
    ("worker-sayshell-ledger", "Sayshell Ledger", "📒",
     "Buys you skepticism; itemizes the cost of doubt."),
    ("worker-comporellon-runner", "Comporellon Runner", "🛰️",
     "Slow, regulated, polite; carries every customs form."),
    ("worker-solaria-civic", "Solaria Civic", "🏛️",
     "Counts to one; declares done; logs out cleanly."),
    ("worker-gaia-accord", "Gaia Accord", "🤝",
     "Same tree, different leaves; all of them connected."),
    ("worker-imperial-accord", "Imperial Accord", "🤝",
     "Approves quietly; signs without flourish."),
    ("worker-galactic-archive", "Galactic Archive", "📚",
     "Lent to you for a week; fines waived once."),
    ("worker-bursar-ledger", "Bursar Ledger", "📒",
     "Has the budget memorized; will not be moved."),
    ("worker-plan-catalog", "Plan Catalog", "🗂️",
     "Yes, this was Seldon-shaped; please file under inevitability."),
    ("worker-trader-vector", "Trader Vector", "➡️",
     "Nine planets a quarter; scales with the merchant fleet."),
    ("worker-foundation-civic", "Foundation Civic", "🏛️",
     "Small currency, big pride; stamps the wax with care."),
    ("worker-subspace-signal", "Subspace Signal", "📶",
     "Instant, mostly; please retry on jitter."),
    ("worker-hyperwave-beacon", "Hyperwave Beacon", "🚨",
     "Alert from afar; please confirm with the local grid."),
    ("worker-senator-vector", "Senator Vector", "➡️",
     "Dust allergies, lengthy speech; lands at a vote."),
    ("worker-senator-ledger", "Senator Ledger", "📒",
     "Strikes out the bad clause; keeps the good comma."),
    ("worker-periphery-frontier", "Periphery Frontier", "🏕️",
     "Very tired settler; reads the charter at noon."),
    ("worker-mayor-ledger", "Mayor Ledger", "📒",
     "Every promise lined up; checks them off slowly."),
    ("worker-atomic-beacon", "Atomic Beacon", "🚨",
     "For the small problems; please do not mistake the scale."),
    ("worker-empire-archive", "Empire Archive", "📚",
     "Mausoleum of bad practice; cited reluctantly."),
    ("worker-galaxy-vector", "Galaxy Vector", "➡️",
     "Annotated by century; please do not redraw."),
    ("worker-anacreon-signal", "Anacreon Signal", "📡",
     "Proud comment; useful, no; routed anyway."),
    ("worker-hober-beacon", "Hober Beacon", "🚨",
     "Two slides; one product; closes confidently."),
    ("worker-bayta-ledger", "Bayta Ledger", "📒",
     "Quiet observations, sharp; keeps the lid on the rumor."),
    ("worker-toran-frontier", "Toran Frontier", "🏕️",
     "Steady hand on the wheel; first to set up camp."),
    ("worker-arkady-ledger", "Arkady Ledger", "📒",
     "Children's book of wartime; kinder than expected."),
    ("worker-hari-archive", "Hari Archive", "📚",
     "Rewatch the lecture; it still works; please update notes."),
    ("worker-crisis-ledger", "Crisis Ledger", "📒",
     "Yes, you paid for that; please retain receipt."),
    ("worker-mule-gate", "Mule Gate", "🚪",
     "Empty; finally; please close behind you."),
    ("worker-gaia-civic", "Gaia Civic", "🏛️",
     "Collective rest; the meeting room agrees."),
    ("worker-trader-ledger", "Trader Ledger", "📒",
     "Signed by ten worlds; cosigned by twelve."),
    ("worker-imperial-catalog", "Imperial Catalog", "🗂️",
     "Remember this for later; the dust is part of it."),
    ("worker-imperial-beacon", "Imperial Beacon", "🔆",
     "Pretty; valueless; still bright on holidays."),
    ("worker-solar-civic", "Solar Civic", "🏛️",
     "Single occupant, lots of rules; please knock first."),
    ("worker-aurora-frontier", "Aurora Frontier", "🪐",
     "Robot mowed; settler approved; lawn perfect."),
    ("worker-aurora-accord", "Aurora Accord", "🤝",
     "Speaks slowly, listens fast; reschedules cheerfully."),
    ("worker-aurora-vector", "Aurora Vector", "➡️",
     "Twenty-two hours per day; please pace yourself."),
    ("worker-solaria-vector", "Solaria Vector", "➡️",
     "Bath house at twenty kilometers; bring a long towel."),
    ("worker-galaxia-concord", "Galaxia Concord", "🪐",
     "Sing-along consensus; everyone knows the second verse."),
    ("worker-palver-ledger", "Palver Ledger", "📒",
     "Small king of routes; very large opinions."),
    ("worker-speaker-signal", "Speaker Signal", "🚨",
     "Wraps the secret well; opens it only when asked."),
    ("worker-mentalic-relay", "Mentalic Relay", "📡",
     "Gentle tweak in transit; you barely notice the difference."),
    ("worker-galactica-ledger", "Galactica Ledger", "📒",
     "Corrected your blurb; preserved the joke."),
    ("worker-trantor-signal", "Trantor Signal", "📡",
     "Checks you for ID; waves you through eventually."),
    ("worker-trantor-frontier", "Trantor Frontier", "🏕️",
     "Three meals, two doors; sleep tight."),
    ("worker-service-gate", "Service Gate", "🚪",
     "Between the stacks; please bring a cart."),
    ("worker-cart-vector", "Cart Vector", "➡️",
     "Eight wheels; warranty void; somehow still rolls."),
    ("worker-mayor-civic", "Mayor Civic", "🏛️",
     "Discount applies to everything; even paperwork."),
    ("worker-council-civic", "Council Civic", "🏛️",
     "Lobbying; legal; bringing tea to make it official."),
    ("worker-foundation-hand", "Foundation Hand", "🤝",
     "Calmly drafts the charter; signs with both hands."),
    ("worker-speaker-catalog", "Speaker Catalog", "🗂️",
     "Names by rank and pause; pronunciations preserved."),
    ("worker-hardin-ledger", "Hardin Ledger", "📒",
     "Already on a sticker; please respect the original."),
    ("worker-hardin-catalog", "Hardin Catalog", "🗂️",
     "Yes, that is an actual cigar; pre-approved."),
    ("worker-mallow-ledger", "Mallow Ledger", "📒",
     "Three deals deep; closes with a handshake."),
    ("worker-mallow-catalog", "Mallow Catalog", "🗂️",
     "Strong, black, closing; please drink before standup."),
    ("worker-mayor-catalog", "Mayor Catalog", "🗂️",
     "Entries triple-stamped; signed by inertia."),
    ("worker-mule-vector", "Mule Vector", "➡️",
     "Affects three lanes at once; please brace."),
    ("worker-pelorat-ledger", "Pelorat Ledger", "📒",
     "Appreciates a footnote; never breaks the prose."),
    ("worker-pelorat-catalog", "Pelorat Catalog", "🗂️",
     "Dense, gentle; every entry an excursion."),
    ("worker-trevize-vector", "Trevize Vector", "➡️",
     "Usually right, somehow; please honor the hunch."),
    ("worker-bliss-accord", "Bliss Accord", "🤝",
     "Connects three teammates; quietly, gracefully."),
    ("worker-fallom-scout", "Fallom Scout", "🪐",
     "Pokes everything; learns fast; please let it explore."),
    ("worker-mentalic-catalog", "Mentalic Catalog", "🗂️",
     "Calmly disambiguates the spec; cites the relevant clause."),
    ("worker-earth-vector", "Earth Vector", "➡️",
     "Buried but cited; please honor in the footnotes."),
    ("worker-galactic-vector", "Galactic Vector", "🌌",
     "Small, dense, busy; aligns the rest of the fleet."),
    ("worker-spacer-beacon", "Spacer Beacon", "🚨",
     "Bridge fee, cosmic; please pay before crossing."),
    ("worker-settler-civic", "Settler Civic", "🏛️",
     "Flag is a flag is a flag; please pause."),
    ("worker-imperial-ledger", "Imperial Ledger", "📒",
     "Tarnished but tradeable; dust included."),
    ("worker-vault-catalog", "Vault Catalog", "🗂️",
     "Page seven; very small print; please use a magnifier."),
    ("worker-crisis-catalog", "Crisis Catalog", "🗂️",
     "Short remarks; long aftermath; index by year."),
    ("worker-speaker-gate", "Speaker Gate", "🚪",
     "Mic for proper nouns; please pronounce the planet."),
    ("worker-capitol-civic", "Capitol Civic", "🏛️",
     "Quiet wars; loud gavels; calm corridors."),
    ("worker-mallow-signal", "Mallow Signal", "📡",
     "Small bet, long horizon; ping arrives years later."),
    ("worker-capitol-frontier", "Capitol Frontier", "🏕️",
     "Entire planet wagered; please bring lawyers."),
    ("worker-council-catalog", "Council Catalog", "🗂️",
     "Folds neatly into the room; hangs from the ceiling."),
    ("worker-senator-catalog", "Senator Catalog", "🗂️",
     "Strikes through everything; preserves a verb."),
    ("worker-sentry-signal", "Sentry Signal", "🚨",
     "Does not chat; you are seen; please proceed."),
    ("worker-hyperwave-relay", "Hyperwave Relay", "📡",
     "Fixes the long route; small drift correction included."),
    ("worker-glia-orbit", "Glia Orbit", "🪐",
     "Three jumps in one; please sit down before initiating."),
    ("worker-stars-orbit", "Stars Orbit", "🪐",
     "Final jump destination; please collect personal items."),
    ("worker-tazenda-orbit", "Tazenda Orbit", "🪐",
     "Just outside reach; rumored to have all the answers."),
    ("worker-rossem-orbit", "Rossem Orbit", "🪐",
     "Slow but loyal; arrives with hand-rolled produce."),
    ("worker-sayshell-orbit", "Sayshell Orbit", "🪐",
     "Checked twice; please bring proof of citizenship."),
    ("worker-comporellon-orbit", "Comporellon Orbit", "🪐",
     "Three pages of stamps; please file by departure."),
    ("worker-solaria-orbit", "Solaria Orbit", "🪐",
     "Rotates politely; please do not crowd the radius."),
    ("worker-aurora-orbit", "Aurora Orbit", "🪐",
     "Pristine, lonely; please admire from afar."),
    ("worker-earth-orbit", "Earth Orbit", "🪐",
     "Barely audible; please listen carefully."),
    ("worker-trantor-archive", "Trantor Archive", "📚",
     "Paper; somehow still here; please handle gently."),
    ("worker-trantor-beacon", "Trantor Beacon", "🚨",
     "Knows the shortcuts; signals when traffic snarls."),
    ("worker-periphery-vector", "Periphery Vector", "➡️",
     "Outer rim worker; please respect the long commute."),
    ("worker-hari-signal", "Hari Signal", "📡",
     "Yes, that was on purpose; please pretend surprise."),
    ("worker-plan-hand", "Plan Hand", "🤝",
     "Catches the falling consensus; sets it back upright."),
    ("worker-speaker-hand", "Speaker Hand", "🤝",
     "Delivers the gentle correction; mid-sentence; respectfully."),
    ("worker-settler-beacon", "Settler Beacon", "🚨",
     "Peace at the end of a long crisis; lights stay on."),
    ("worker-periphery-orbit", "Periphery Orbit", "🪐",
     "Final stop; please bring your own dinner."),
    ("worker-encyclopedia-civic", "Encyclopedia Civic", "🏛️",
     "Lent to the council; returned with annotations."),
    ("worker-galactic-frontier", "Galactic Frontier", "🏕️",
     "Last camp before the void; please conserve oxygen."),
    ("worker-imperial-civic", "Imperial Civic", "🏛️",
     "Old shrine, new committee; respect the bench."),
    ("worker-relay-runner", "Relay Runner", "🛰️",
     "Steady pace; passes the baton without missing the call."),
    ("worker-vault-runner", "Vault Runner", "🛰️",
     "Vault sentry shift; please confirm fingerprint scan."),
    ("worker-archive-clerk", "Archive Clerk", "📒",
     "Catalogs the lecture in three takes; files chronologically."),
    ("worker-relay-clerk", "Relay Clerk", "📒",
     "Logs every ping; signs every reply; never misses."),
    ("worker-ledger-hand", "Ledger Hand", "🤝",
     "Carries your column to the next page; gently."),
    ("worker-evidence-clerk", "Evidence Clerk", "📒",
     "Tags the artifact carefully; cross-references the find."),
    ("worker-evidence-hand", "Evidence Hand", "🤝",
     "Hands you the paper labeled exactly correctly."),
    ("worker-orbit-clerk", "Orbit Clerk", "📒",
     "Tracks the long ellipse; calls out periapsis on time."),
]

# --- validation ------------------------------------------------------
seen_keys = set()
for key, *_ in BROKERS + WORKERS:
    assert key not in seen_keys, f"duplicate key {key}"
    seen_keys.add(key)

for _, name, emoji, *_ in BROKERS:
    assert BROKER_KEYWORDS.search(name), f"broker missing keyword: {name!r}"
    assert not BROKER_FORMULAIC.match(name), f"broker formulaic: {name!r}"
    assert emoji in ALLOWED_BROKER_EMOJI, (
        f"broker emoji {emoji!r} not allowed for {name!r}"
    )

for _, name, emoji, *_ in WORKERS:
    parts = name.split()
    assert 1 <= len(parts) <= 3, f"worker not 1-3 words: {name!r}"
    assert WORKER_KEYWORDS.search(name), f"worker missing keyword: {name!r}"
    assert not WORKER_FORMULAIC.match(name), f"worker formulaic: {name!r}"
    assert not BANNED_WORKER_TOKENS.search(name), (
        f"worker has banned token: {name!r}"
    )
    assert emoji in ALLOWED_WORKER_EMOJI, (
        f"worker emoji {emoji!r} not allowed for {name!r}"
    )

# --- uniqueness probe ------------------------------------------------
def hash_str(value: str) -> int:
    h = 2166136261
    for ch in value:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h

def pick_at_seed(seed: str, role: str, pool: list) -> str:
    return pool[hash_str(f"{seed}:built-in-foundation-{role}-character") % len(pool)]

worker_pool = [k for k, *_ in WORKERS]
worker_seen = set()
for i in range(300):
    worker_seen.add(pick_at_seed(f"worker-{i}", "worker", worker_pool))

descriptor = {
    "key": "foundation",
    "aliases": [
        "foundation",
        "foundation/space",
        "space",
        "archive",
        "institutional sci-fi",
        "trantor",
        "psychohistory",
    ],
    "displayName": "Foundation",
    "intent": (
        "Whimsical Foundation-flavored Pinet identities with Time Vault, "
        "Salvor Hardin, Hober Mallow, the Mule, Bayta and Toran, "
        "Arcadia, Pelorat, Trevize, Bliss, Fallom, Trantor, Aurora, "
        "Solaria, Comporellon, Sayshell, and Gaia easter eggs. "
        "Static authored characters; no LLM calls in startup or join."
    ),
    "fallback": "default",
    "roles": {
        "broker": {
            "characterPool": [k for k, *_ in BROKERS],
            "namePattern": "{character}",
        },
        "worker": {
            "characterPool": [k for k, *_ in WORKERS],
            "namePattern": "{character}",
        },
    },
    "characters": {},
    "statusVocabulary": {
        "idle": "standing by",
        "working": "on relay",
        "healthy": "signal green",
        "stale": "signal lagging",
        "ghost": "off grid",
        "resumable": "recoverable relay",
    },
}

for entry in BROKERS:
    if len(entry) == 5:
        key, name, emoji, persona, style = entry
    else:
        key, name, emoji, persona = entry
        style = ["civic", "scholarly", "long-view"]
    descriptor["characters"][key] = {
        "name": name,
        "emoji": emoji,
        "persona": persona,
        "style": style,
    }

for entry in WORKERS:
    if len(entry) == 5:
        key, name, emoji, persona, style = entry
    else:
        key, name, emoji, persona = entry
        style = ["whimsical", "fan-service", "concise"]
    descriptor["characters"][key] = {
        "name": name,
        "emoji": emoji,
        "persona": persona,
        "style": style,
    }

with open("slack-bridge/skins/foundation.json", "w", encoding="utf-8") as fh:
    json.dump(descriptor, fh, indent=2, ensure_ascii=False)
    fh.write("\n")

print(
    f"wrote foundation.json: {len(BROKERS)} brokers, {len(WORKERS)} workers, "
    f"{len(worker_seen)} unique workers / 300 deterministic seeds."
)
