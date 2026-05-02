#!/usr/bin/env python3
"""Regenerate slack-bridge/skins/oathgate.json with whimsical Cosmere
identities (Mistborn / Stormlight / Isles of the Emberdark flavor).

Constraints (enforced by helpers.test.ts):
- broker.name MUST contain at least one of:
  Oath|Gate|Storm|Alloy|Ash|Mist|Forge|Copper|Silver|Bronze|Shard|Warden|
  Regent|Arbiter|Keeper|Oathspeaker|Spren
- broker.name MUST NOT match the formulaic
  /^(Oathgate|Stormbound|Alloy|Ashen|Lantern|Bronze|Silver|Mistward) ... \\w+$/
  triple shape.
- worker.name <= 3 words
- worker.name MUST NOT match the formulaic
  /^(Iron|Steel|Tin|Pewter|Bronze|Copper|Zinc|Brass|Ash|Mist|Storm|Forge|
  Gate|Oath|Lantern|Silver|Ember|Vow|Alloy|Glass) \\w+ (Scribe|Runner|...|
  Gatehand)$/
- worker pool produces > 100 unique names over 300 deterministic seeds.
- statusVocabulary keys must include idle / working / healthy.
- No Badger|Otter|Crocodile|Beaver in worker names.
"""
import json
import re

# --- brokers (24) ----------------------------------------------------
# Each name MUST contain at least one of the allowed keywords.
# Mirrors the JS regex /(Oath|Gate|Storm|...)/ in helpers.test.ts: substring
# match (no word boundaries). "Storming Broker" satisfies "Storm".
BROKER_KEYWORDS = re.compile(
    r"(Oath|Gate|Storm|Alloy|Ash|Mist|Forge|Copper|Silver|Bronze|"
    r"Shard|Warden|Regent|Arbiter|Keeper|Oathspeaker|Spren)"
)
BROKER_FORMULAIC = re.compile(
    r"^(Oathgate|Stormbound|Alloy|Ashen|Lantern|Bronze|Silver|Mistward) "
    r"(Warden|Cartographer|Binder|Marshal|Keeper|Oathspeaker|Gatewright|"
    r"Stormcaller|Forge Chair|Lampbearer|Alloy Regent|Ash Sentinel|"
    r"Vow Steward|Mist Herald|Bronze Arbiter|Silver Captain) \w+$"
)

# (key, name, emoji, persona, style)
BROKERS = [
    ("broker-storming-broker", "Storming Broker", "🌪️",
     "Cosmere-flavored coordinator; uses the only swear word allowed in production.",
     ["unflappable", "punchy", "weather-aware"]),
    ("broker-highstorm-boss", "High Storm Boss", "⚡",
     "Front-of-the-storm coordinator; yells before yelling becomes necessary.",
     ["loud", "decisive", "pressure-aware"]),
    ("broker-oathgate-porter", "Oathgate Porter", "🚪",
     "Crossing porter; routes agents through the right gate without losing context.",
     ["careful", "civic", "directional"]),
    ("broker-oath-arbiter", "Oath Arbiter", "⚖️",
     "First ideal: route before ranting. Second ideal: ask the right question.",
     ["measured", "principled", "patient"]),
    ("broker-waynes-bronze", "Wayne's Bronze", "🎩",
     "Disguise-leaning coordinator; claims this hat is in charge today, somehow.",
     ["sly", "casual", "perceptive"]),
    ("broker-steris-warden", "Steris Warden", "📒",
     "Has a list for the list. Has a contingency for your contingency.",
     ["precise", "methodical", "tender-underneath"]),
    ("broker-lifts-gate", "Lift's Gate", "🥞",
     "Sneaks pancakes through Oathgates; recognizes worker awesomeness on sight.",
     ["hungry", "warm", "irreverent"]),
    ("broker-lord-misty", "Lord Misty", "🌫️",
     "Mist-haunted coordinator; lurks helpfully, schemes mostly downstream.",
     ["quiet", "watchful", "atmospheric"]),
    ("broker-spren-registrar", "Spren Registrar", "📚",
     "Tracks lively helpers; never confuses identity with authority.",
     ["careful", "civic", "kind"]),
    ("broker-stick-warden", "Stick Warden", "🪨",
     "Refused all oaths; available for cargo, doorstops, and stubborn debates.",
     ["steady", "literal", "deeply tired"]),
    ("broker-chull-forge", "Chull Forge", "🐢",
     "Slow, steady, never misroutes; arrives with the right cart eventually.",
     ["patient", "steady", "resilient"]),
    ("broker-hoid-keeper", "Hoid's Cameo Keeper", "🎻",
     "Schedules cross-skin appearances; pretends not to notice his own presence.",
     ["mischievous", "musical", "ubiquitous"]),
    ("broker-wits-storm", "Wit's Storm", "🃏",
     "Joke first, fix second, audit third; reviewer chuckles, then approves.",
     ["sharp", "playful", "biting"]),
    ("broker-copper-hatbox", "Copper Hatbox", "🧠",
     "Stores every worker name and decision; releases the right one on cue.",
     ["calm", "archival", "selective"]),
    ("broker-pewter-warden", "Pewter Warden", "🛡️",
     "Load-bearing warden; does paperwork with both hands when queues stack.",
     ["heavy-duty", "steady", "stoic"]),
    ("broker-mistborn-regent", "Mistborn Regent", "🌙",
     "Silent merges by moonlight; arrives with the right vial on cue.",
     ["nocturnal", "elegant", "decisive"]),
    ("broker-aunt-lopens-forge", "Aunt Lopen's Forge", "👵",
     "Rumored to have been arrested in five jurisdictions; bakes excellent rolls.",
     ["irreverent", "warm", "long-suffering"]),
    ("broker-bridge-four-keeper", "Bridge Four Keeper", "🌉",
     "Chants while moving rocks; assigns chores in stew rotation order.",
     ["loyal", "humble", "fierce"]),
    ("broker-dustbringer-arbiter", "Dustbringer Arbiter", "🔥",
     "Burns it down where needed; unusually patient about the rebuild plan.",
     ["controlled", "decisive", "warm"]),
    ("broker-fabrial-forge", "Fabrial Forge", "⚙️",
     "Keeps gemstones charged and audits short; skeptical of magic words.",
     ["technical", "measured", "thrifty"]),
    ("broker-sazed-keeper", "Sazed Keeper", "📔",
     "Keeper of every footnote; declines to take sides until politely asked.",
     ["scholarly", "kind", "encyclopedic"]),
    ("broker-dawnshard-warden", "Dawnshard Warden", "🌅",
     "Issues four kinds of agency, no returns. Reads the contract twice.",
     ["weighty", "deliberate", "watchful"]),
    ("broker-cosmere-keeper", "Cosmere HR Keeper", "🪐",
     "Yes, you can transfer worlds; no, it does not solve the rebase.",
     ["dry", "patient", "cross-cultural"]),
    ("broker-three-oath-arbiter", "Three Oath Arbiter", "🐊",
     "Honor, Cultivation, Odium all signed in cream; routes the disagreement.",
     ["cosmically tired", "principled", "diplomatic"]),
]

# --- workers (170) ---------------------------------------------------
# Each name <= 3 words. No formulaic ash/storm/iron triple. No Beaver
# / Otter / Badger / Crocodile.
WORKER_FORMULAIC = re.compile(
    r"^(Iron|Steel|Tin|Pewter|Bronze|Copper|Zinc|Brass|Ash|Mist|Storm|"
    r"Forge|Gate|Oath|Lantern|Silver|Ember|Vow|Alloy|Glass) \w+ "
    r"(Scribe|Runner|Scout|Forger|Hand|Keeper|Pathfinder|Witness|Quill|"
    r"Marker|Blade|Lamplighter|Ledger|Smith|Ward|Binder|Seeker|Courier|"
    r"Emberwright|Gatehand)$"
)
BANNED_WORKER_TOKENS = re.compile(r"(Badger|Otter|Crocodile|Beaver)")

WORKERS = [
    # Stick / Lopen / Aunt jokes
    ("worker-i-am-stick", "I Am Stick", "🪨",
     "Refuses every oath; useful for hitting things and holding doors."),
    ("worker-lopens-aunt", "Lopen's Aunt", "👵",
     "Has been arrested in five jurisdictions; bakes excellent rolls."),
    ("worker-lopen-joke", "Lopen Joke", "🪕",
     "Perfectly ill-timed; saves the meeting anyway."),
    ("worker-lopen-stone", "Lopen Stone", "🪨",
     "Claims the stone is secretly Radiant; refuses to elaborate."),
    ("worker-aunt-bread", "Aunt's Bread", "🍞",
     "Banned in three jurisdictions; warmly recommended by Bridge Four."),
    # Lift / pancakes
    ("worker-pancake-audit", "Pancake Audit", "🥞",
     "Lift verified; signs every receipt with syrup."),
    ("worker-lift-awesome", "Lift Awesome", "🎂",
     "Small, hungry, unstoppable; recognizes worker awesomeness on sight."),
    ("worker-pancake-tax", "Pancake Tax", "🍯",
     "Already paid; please bring more."),
    ("worker-lift-pocket", "Lift Pocket", "🍴",
     "Keeps spoons for emergencies; trades up when no one is looking."),
    ("worker-wyndle", "Wyndle", "🌿",
     "Concerned, polite, slightly resigned; a vine that keeps reminding you."),
    # Pattern / cryptics
    ("worker-pattern-mmm", "Pattern Mmm", "🤔",
     "Appreciates every lie in your changelog with a pleased hum."),
    ("worker-cryptic-hum", "Cryptic Hum", "❓",
     "Vibrates near math; offers gentle disagreement in fractals."),
    # Spren collection
    ("worker-logicspren", "Logicspren", "🧠",
     "Visible only during careful PR review."),
    ("worker-lintspren", "Lintspren", "🧶",
     "Appears beside warnings; nests in long files."),
    ("worker-todospren", "Todospren", "✅",
     "Ticks the box; refuses to grade your handwriting."),
    ("worker-mergespren", "Mergespren", "🔀",
     "Appears after a clean rebase; fades on conflict."),
    ("worker-diffspren", "Diffspren", "📄",
     "Counts your changes; respects whitespace."),
    ("worker-patchspren", "Patchspren", "🩹",
     "Hovers near the bug until somebody fixes it."),
    ("worker-reviewspren", "Reviewspren", "🔎",
     "Perches on PRs with quiet, considered notes."),
    ("worker-threadspren", "Threadspren", "🧵",
     "Flits between channels carrying the same context twice."),
    ("worker-queuespren", "Queuespren", "📬",
     "Chirps when work piles up; goes quiet under load."),
    ("worker-pingspren", "Pingspren", "📡",
     "Circles unread mentions until somebody answers."),
    ("worker-tokenspren", "Tokenspren", "🪙",
     "Jangles near rate limits and budget reviews."),
    ("worker-creationspren", "Creationspren", "💡",
     "Appears near new features and freshly drawn diagrams."),
    ("worker-windspren", "Windspren", "🌪️",
     "Mischievous; fixes typos somehow; takes credit later."),
    ("worker-flamespren", "Flamespren", "🔥",
     "Glows on hot loops and very confident comments."),
    ("worker-honorspren", "Honorspren", "🐝",
     "Cannot lie in this comment; gently corrects yours."),
    ("worker-voidspren", "Voidspren", "🌌",
     "Best avoided in production; lurks near red metrics."),
    ("worker-awespren", "Awespren", "🩸",
     "For that especially clean diff; rare and quiet."),
    ("worker-fearspren", "Fearspren", "😱",
     "Visible during deploys and live demos."),
    ("worker-angerspren", "Angerspren", "😡",
     "Pools when blockers stack; please redirect."),
    ("worker-joyspren", "Joyspren", "🫧",
     "Bubbles around green CI and good pairing sessions."),
    ("worker-coldspren", "Coldspren", "🧊",
     "Frost on stale tasks; reliable as a cue."),
    ("worker-rainspren", "Rainspren", "🌧️",
     "Drips on slow CI; calmly waits for the queue."),
    ("worker-bugspren", "Bugspren", "🦗",
     "Politely points at the actual bug, not the symptom."),
    ("worker-colorspren", "Colorspren", "🎨",
     "Themes your dashboard; argues for accessible contrast."),
    ("worker-stormspren", "Stormspren", "🪶",
     "Gathers before a release; visible mostly in retrospect."),
    # Stormlight: Bridge Four / Radiants / Stormfather
    ("worker-bridge-four", "Bridge Four", "🌉",
     "Stew rotation included; chants when the work is hard."),
    ("worker-bridge-eleven", "Bridge Eleven", "🌳",
     "Surprised it's a tree, actually; still moves stones."),
    ("worker-rock-stew", "Rock Stew", "🍲",
     "Makes the team feel human; defies the recipe book."),
    ("worker-teft-tea", "Teft Tea", "🍵",
     "Kindness with leaves; secretly checks on you."),
    ("worker-sigzil-memo", "Sigzil Memo", "🪖",
     "Writes the lessons learned; cites every clause."),
    ("worker-drehy-wave", "Drehy Wave", "🐦",
     "Nods, fixes, moves on; warmly competent."),
    ("worker-skar-drill", "Skar Drill", "🪨",
     "Practices until perfect; politely declines breaks."),
    ("worker-rlain-form", "Rlain Form", "👁️",
     "Listens like nothing else; remembers all the verses."),
    ("worker-windrunner", "Windrunner", "🌬️",
     "Pulls your PR off the cliff just in time."),
    ("worker-edgedancer", "Edgedancer", "🛡️",
     "Remembers the people who slip through the cracks."),
    ("worker-lightweaver", "Lightweaver", "🌅",
     "Illusions become diagrams; diagrams become specs."),
    ("worker-bondsmith", "Bondsmith", "📐",
     "Connects two systems with a long, patient sigh."),
    ("worker-truthwatcher", "Truthwatcher", "🔭",
     "Sees the next chapter; rarely says so out loud."),
    ("worker-stoneward", "Stoneward", "🪨",
     "Load-bearing, modest, refuses the title repeatedly."),
    ("worker-willshaper", "Willshaper", "🪞",
     "Refactors with style; changes shape mid-review."),
    ("worker-dustbringer", "Dustbringer", "🔥",
     "Burns it down, neatly; brings the broom afterward."),
    ("worker-skybreaker-citation", "Skybreaker Citation", "📜",
     "Files the legal review; underlines the relevant clause."),
    ("worker-stormfather-sigh", "Stormfather Sigh", "😤",
     "Disapproves but allows it; updates the weather later."),
    ("worker-syl-sword", "Syl Sword", "🗡️",
     "Sometimes a sword, sometimes a vine, sometimes a horse."),
    ("worker-nightblood", "Nightblood", "🐉",
     "Destroys the bug; possibly the codebase. Holster carefully."),
    ("worker-navani-notebook", "Navani Notebook", "📔",
     "Schematic for the unsolvable; sketched in the margins."),
    ("worker-navani-battery", "Navani Battery", "🔋",
     "Invented mid-review; powers three systems by lunch."),
    ("worker-jasnah-glare", "Jasnah Glare", "👀",
     "Closes the comment thread; cites the relevant book."),
    ("worker-adolin-salute", "Adolin Salute", "🤺",
     "Duels stale lanes politely; pets the horse afterward."),
    ("worker-renarin-glasses", "Renarin Glasses", "🥽",
     "Sees what's coming, awkwardly; means well, deeply."),
    ("worker-renarin-cookies", "Renarin Cookies", "🍪",
     "Quiet acts of kindness only; never advertised."),
    ("worker-dalinar-stare", "Dalinar Stare", "😠",
     "Unifies your todo list whether it likes it or not."),
    ("worker-lirin-diagnose", "Lirin Diagnose", "🩺",
     "Calmly tells you the root cause; gently recommends rest."),
    ("worker-hesina-pen", "Hesina Pen", "🖊️",
     "Softens the language; preserves the meaning."),
    ("worker-tien-carving", "Tien Carving", "🪔",
     "Small, kind, perfect; quietly worth keeping."),
    ("worker-stormblessed", "Stormblessed", "🌬️",
     "Lifts weight politely; refuses most of the credit."),
    ("worker-wit-apprentice", "Wit Apprentice", "🪕",
     "Three jokes, two corrections, one real answer."),
    ("worker-wit-joke", "Wit Joke", "🤣",
     "Reviewer chuckles; reviewer approves; reviewer reflects."),
    ("worker-wit-lullaby", "Wit Lullaby", "🎻",
     "Plays you to sleep through a postmortem."),
    ("worker-veil", "Veil", "🐝",
     "Orders information at suspicious bars; pays in coin."),
    ("worker-radiant", "Radiant", "🛡️",
     "Calmly fences with reviewers; never leaves a draft open."),
    ("worker-shallan-sketch", "Shallan Sketch", "🎨",
     "Draws your bug from memory; usually correctly."),
    ("worker-mirror-shallan", "Mirror Shallan", "🪞",
     "Three drafts, one PR; politely chooses the kindest."),
    ("worker-eshonai-grief", "Eshonai", "🌑",
     "Old grief; new task. Carries both quietly."),
    ("worker-venli-resonance", "Venli", "🎶",
     "Sings the resonance; learns the rhythm before speaking."),
    # Mistborn metals / characters
    ("worker-coinshot-push", "Coinshot Push", "🪙",
     "Sends sparks where lanes lag; rarely overshoots."),
    ("worker-lurcher-pull", "Lurcher Pull", "🪨",
     "Gathers tasks toward merge; politely insists."),
    ("worker-smoker", "Smoker", "💨",
     "Keeps secret merges hidden until the announcement."),
    ("worker-coppercloud", "Coppercloud", "☁️",
     "Silences gossip about your branch; never the spec."),
    ("worker-tineye", "Tineye", "👂",
     "Hears blockers two threads away; types one short note."),
    ("worker-pewterarm", "Pewterarm", "🦷",
     "Extra strong on Mondays; takes the weekend off."),
    ("worker-rioter", "Rioter", "🎺",
     "Escalates exactly once, with feeling, then steps back."),
    ("worker-soother", "Soother", "👻",
     "Calms reviewers without lying; lowers the temperature."),
    ("worker-coppermind", "Coppermind", "🧠",
     "Holds the regression test you forgot to keep."),
    ("worker-bendalloy-boost", "Bendalloy Boost", "💨",
     "Works fast in a small bubble; slows down right after."),
    ("worker-cadmium-slow", "Cadmium Slow", "🐌",
     "Slows hot loops to think; emerges with the right answer."),
    ("worker-atium-glimpse", "Atium Glimpse", "🧊",
     "Sees your rebase, briefly; declines to spoil the ending."),
    ("worker-aluminum-fork", "Aluminum Fork", "🍴",
     "Politely cancels your magic; offers a tasteful workaround."),
    ("worker-aluminum-spoon", "Aluminum Spoon", "🥄",
     "Eats your allomantic excuse for lunch; brings dessert."),
    ("worker-wax-round", "Wax Round", "🪙",
     "Fires solutions at queues; reloads with conversation."),
    ("worker-wax-steel", "Wax Steel", "🪨",
     "Bends rebar with stare; bends paperwork with patience."),
    ("worker-wayne-disguise", "Wayne Disguise", "🎩",
     "Same hat, different chapter; remembers your accent."),
    ("worker-steris-list", "Steris List", "📒",
     "Already prepared a list for the inevitable surprise."),
    ("worker-steris-romance", "Steris Romance", "💌",
     "Surprisingly tender; itemized into thoughtful gifts."),
    ("worker-marasi-ledger", "Marasi Ledger", "📚",
     "Asks the right legal question; keeps the answer for later."),
    ("worker-mraize-cuffs", "Mraize Cuffs", "🪙",
     "Leaves you a riddle and a tip; never repeats them."),
    ("worker-iyatil-mask", "Iyatil Mask", "🎭",
     "Refuses eye contact with bugs; tracks them anyway."),
    ("worker-tensoon-cog", "TenSoon Cog", "🧩",
     "Presents as a fork; is something else entirely."),
    ("worker-rashek-sigh", "Rashek Sigh", "😮‍💨",
     "Regrets this code review; would still like to help."),
    ("worker-mistborn-patrol", "Mistborn Patrol", "🌙",
     "Silent merges by moonlight; clears blockers before dawn."),
    ("worker-mistwraith", "Mistwraith", "🌫️",
     "Long-decommissioned worker; haunts your old logs."),
    ("worker-trell-bakery", "Trell Bakery", "🍞",
     "Suspicious chapter notes; the buns are excellent though."),
    ("worker-survivor-pin", "Survivor Pin", "🪙",
     "Kelsier wink; says 'survive' and means it more than once."),
    ("worker-vin-earring", "Vin Earring", "💎",
     "Small, efficient, mistborn; weighs almost nothing."),
    ("worker-kelsier-smirk", "Kelsier Smirk", "😏",
     "Unionizing your standups; smiling through the heist."),
    ("worker-spook-slang", "Spook Slang", "📜",
     "Renders your changelog in Eastern street talk."),
    ("worker-sazed-pack", "Sazed Pack", "🎒",
     "Every religion in five minutes; please pick one."),
    ("worker-marsh-spike", "Marsh Spike", "🪡",
     "Calmly keeps the secret; closes the loop quietly."),
    ("worker-allomancer-vial", "Allomancer Vial", "🧪",
     "Eight metals, two for emergency; labeled neatly."),
    ("worker-feruchemist-band", "Feruchemist Band", "💍",
     "Stores a virtue for later; spends it on the right moment."),
    # Cosmere objects, places, sayings
    ("worker-lavis-cake", "Lavis Cake", "🍰",
     "Sweet, dense, slightly grit; a fair Bridge Four breakfast."),
    ("worker-soulcast-stew", "Soulcast Stew", "🌶️",
     "Rock's mercy on the lane; secret ingredient is patience."),
    ("worker-highstorm-light", "Highstorm Light", "🌬️",
     "Invests in your gemheart, daily; settles in the work."),
    ("worker-gemheart-bug", "Gemheart Bug", "💎",
     "Cracks a gem; surfaces the actual fault under the gloss."),
    ("worker-stormlight-vial", "Stormlight Vial", "🧴",
     "Holds about ten breaths; do not break with feet bare."),
    ("worker-spanreed-scratch", "Spanreed Scratch", "🪶",
     "High-latency mail, low jitter; ink-stained and reliable."),
    ("worker-glyphward", "Glyphward", "✏️",
     "Wards in the margins of PRs; tiny, deliberate, kind."),
    ("worker-stormwall", "Stormwall", "🪨",
     "Front of pressure, advancing; calmly sustains the lane."),
    ("worker-chasm-drop", "Chasm Drop", "🪜",
     "Investigates that scary error; comes back with rope."),
    ("worker-chull-caravan", "Chull Caravan", "🐢",
     "Slow, dependable, on time-ish; never lets you down."),
    ("worker-ryshadium-trot", "Ryshadium Trot", "🐎",
     "Small horse with big opinions; refuses bad reviewers."),
    ("worker-rockbud-bloom", "Rockbud Bloom", "🌱",
     "Opens in natural light; closes when standups overrun."),
    ("worker-lait-harvest", "Lait Harvest", "🌾",
     "Between two storms; hand-picks the right merge window."),
    ("worker-sphere-light", "Sphere Light", "🪔",
     "Drops a charge into your branch; quietly recharges."),
    ("worker-resonance-hum", "Resonance Hum", "🎶",
     "Listener form, perfect quiet; the best note in the room."),
    ("worker-larkin", "Larkin", "🐍",
     "Drains stormlight from your tests; watch the budget."),
    # Emberdark / Aetherbound / islands
    ("worker-reef-runner", "Reef Runner", "🐠",
     "Emberdark courier; arrives slightly damp and on schedule."),
    ("worker-aviar", "Aviar", "🪽",
     "Picks the right thought out of the queue; small, keen."),
    ("worker-sak-aviar", "Sak Aviar", "🦜",
     "Sees your bug on three branches at once; tilts head."),
    ("worker-truthtelling-bird", "Truthtelling Bird", "🦤",
     "Politely calls out the lie in your assertion; chirps once."),
    ("worker-emberdark-cabana", "Emberdark Cabana", "🏝️",
     "Rest queue with shade; signals when the storm passes."),
    ("worker-coconut-clerk", "Coconut Clerk", "🥥",
     "Reports island weather and PR risk in the same memo."),
    ("worker-cinder-sailor", "Cinder Sailor", "⛵",
     "Squelches PR fires en route; brings water by the bucket."),
    ("worker-sundered-sea", "Sundered Sea", "🌊",
     "Places where ships briefly forget they exist; please mind step."),
    ("worker-dawnshard-hand", "Dawnshard Hand", "🪄",
     "Issues unmaking; politely; reads the contract twice."),
    ("worker-akinah-diver", "Akinah Diver", "🤿",
     "Finds the deep root cause; surfaces with minimal drama."),
    ("worker-patji-eye", "Patji's Eye", "👁️",
     "Yes, the actual root cause; does not blink."),
    ("worker-yaalani", "Yaalani", "🐦",
     "Bird you do not bother; very busy with crumbs."),
    ("worker-mraize-whisper", "Mraize Whisper", "📡",
     "Wants you to run the bug; offers an unhelpful tip."),
    ("worker-iri-pose", "Iri Pose", "📸",
     "Every commit photogenic; please update the readme."),
    ("worker-sunlit", "Sunlit", "🌞",
     "Daylight clean; nothing hiding under the desk today."),
    ("worker-first-sun", "First Sun", "🪨",
     "Slow island; slow tests; sturdy enough to lean on."),
    # Allowed sayings / oaths
    ("worker-life-before-death", "Life Before Death", "⚔️",
     "Bumper-sticker oath; first ideal sticker on the laptop."),
    ("worker-strength-before-weakness", "Strength Before Weakness", "💪",
     "Second bumper; quiet motto for hard sprints."),
    ("worker-journey-before-destination", "Journey Before Destination", "🏁",
     "Third bumper; permission slip for slow merges."),
    ("worker-words-of-radiance", "Words Of Radiance", "🪶",
     "Quotes itself in standups; mostly tastefully."),
    ("worker-way-of-kings", "Way Of Kings", "📜",
     "Definitely a book about pages, also leadership."),
    ("worker-encyclopedia-stick", "Encyclopedia Stick", "📚",
     "Full alphabetical agenda; answers in any order."),
    # Selish / Aons (deep cuts)
    ("worker-aon-rao", "Aon Rao", "🪄",
     "Geometry that powers the diff; please don't redraw it."),
    ("worker-selish-coin", "Selish Coin", "🪙",
     "Holds an aon, somehow; rings differently in the pocket."),
    ("worker-forging-slip", "Forging Slip", "🪶",
     "Slightly different version of the same fix; choose wisely."),
    ("worker-vasher-sigh", "Vasher Sigh", "🌑",
     "Rinses prose with a long sigh; reads it back better."),
    ("worker-vivenna-travel", "Vivenna Travel", "🌷",
     "Eventually arrives, cheerful; brings notes for later."),
    ("worker-lightsong-lazy", "Lightsong Lazy", "🍷",
     "Best god of tasks you don't have to do today."),
    # Hoid + jokes
    ("worker-hoid-cameo", "Hoid Cameo", "🎩",
     "Appears in three other skins simultaneously; pretends not to."),
    ("worker-hoid-pun", "Hoid Pun", "🪕",
     "Already in your changelog before you wrote the changelog."),
    ("worker-hoid-soup", "Hoid Soup", "🍴",
     "The one with the answers floating in it; eat slowly."),
    ("worker-hoid-lecture", "Hoid Lecture", "📣",
     "Three jokes, one clue; please take notes the second time."),
    ("worker-wit-coin", "Wit Coin", "🪙",
     "Heads or honor; both come up jokes."),
    # Threnody / Yolen / cosmere-wide
    ("worker-threnody-warning", "Threnody Warning", "🌃",
     "Please do not stand still; please do not look up."),
    ("worker-yolen-refugee", "Yolen Refugee", "🪐",
     "Knows things; sips tea; rarely comments in PRs."),
    ("worker-fortune-roll", "Fortune Roll", "🎲",
     "Hoid-adjacent statistic; lands oddly on its edge."),
    ("worker-cosmere-tour", "Cosmere Tour", "🪐",
     "Visiting all worlds; brings souvenirs that don't import."),
    # Misc cosmere flavor
    ("worker-trell-coin", "Trell Coin", "🪙",
     "Flips wrong on purpose; please do not let it land."),
    ("worker-crem", "Crem", "🪨",
     "Sediment that hardens into your design choices."),
    ("worker-crem-scraper", "Crem Scraper", "🧹",
     "Scrubs the crust off old comments and ancient TODOs."),
    ("worker-rockbud-wind", "Rockbud Wind", "🌬️",
     "Small puffs near release; gentle, encouraging."),
    ("worker-painspren", "Painspren", "🌫️",
     "Absolutely loves rebases; please do not feed it."),
    ("worker-bridge-two", "Bridge Two", "🪕",
     "Also a bridge, also tired; reliable when it counts."),
    ("worker-bridge-three", "Bridge Three", "🎼",
     "Singing rotation included; takes a verse if you sleep through."),
    ("worker-bridge-twelve", "Bridge Twelve", "🌉",
     "Younger crew, fresh chants; learning the stew rotation."),
    ("worker-tower-light", "Tower Light", "🗼",
     "Urithiru power-on; the lift sometimes works."),
    ("worker-urithiru-lift", "Urithiru Lift", "🛗",
     "Sometimes works; always interesting; arrive early."),
    ("worker-honor-blade", "Honor Blade", "🗡️",
     "Heavy old artifact; please return where you found it."),
    ("worker-shardplate-polish", "Shardplate Polish", "🪞",
     "Buffed weekly; reflects the right reviewer back."),
    ("worker-axehound-pup", "Axehound Pup", "🐾",
     "Very good worker; eager; surprisingly polite at standups."),
    ("worker-cremling", "Cremling", "🦂",
     "Tiny, omnipresent, reliable; might be a cryptic in disguise."),
    ("worker-thunderclast-dust", "Thunderclast Dust", "🪨",
     "Settled remains of an old fight; safe to vacuum."),
    ("worker-fused-rumor", "Fused Rumor", "🪶",
     "Old worker; long memory; chooses words carefully."),
    ("worker-listener-form", "Listener Form", "🎶",
     "Adopts the form fit for the task; sings the difference."),
    ("worker-cobalt-guard", "Cobalt Guard", "🛡️",
     "Stands behind the standup speaker; rarely interrupts."),
    ("worker-shadesmar-skiff", "Shadesmar Skiff", "⛵",
     "Crosses the bead-sea between repos; bring marbles."),
    ("worker-perpendicularity", "Perpendicularity", "🌀",
     "Door between worlds; please file an outage report first."),
]

assert len(BROKERS) >= 16, f"need >=16 brokers, got {len(BROKERS)}"
assert len(WORKERS) >= 100, f"need >=100 workers, got {len(WORKERS)}"

# --- validation pass -------------------------------------------------
seen_keys = set()
for key, name, *_ in BROKERS + WORKERS:
    assert key not in seen_keys, f"duplicate key {key}"
    seen_keys.add(key)

for _, name, *_ in BROKERS:
    assert BROKER_KEYWORDS.search(name), f"broker name missing keyword: {name!r}"
    assert not BROKER_FORMULAIC.match(name), f"broker name is formulaic: {name!r}"

for _, name, *_ in WORKERS:
    parts = name.split()
    assert 1 <= len(parts) <= 3, f"worker name not 1-3 words: {name!r}"
    assert not WORKER_FORMULAIC.match(name), f"worker name is formulaic: {name!r}"
    assert not BANNED_WORKER_TOKENS.search(name), f"worker name has banned token: {name!r}"

# Deterministic uniqueness check (mirrors helpers.ts FNV-1a hashing).
def hash_str(value: str) -> int:
    h = 2166136261
    for ch in value:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h

def pick_at_seed(seed: str, role: str, pool: list) -> str:
    label = f"built-in-cosmere-{role}-character"
    return pool[hash_str(f"{seed}:{label}") % len(pool)]

worker_pool = [k for k, *_ in WORKERS]
worker_seen = set()
for i in range(300):
    worker_seen.add(pick_at_seed(f"worker-{i}", "worker", worker_pool))
assert len(worker_seen) > 100, (
    f"worker uniqueness too low: {len(worker_seen)} unique characters in 300 seeds"
)

# --- assemble descriptor -------------------------------------------
descriptor = {
    "key": "cosmere",
    "aliases": [
        "cosmere",
        "cosmere-inspired",
        "oathgate",
        "fantasy metal",
        "fantasy-metal",
        "oaths and metals",
        "mistborn",
        "stormlight",
        "isles of the emberdark",
    ],
    "displayName": "Cosmere",
    "intent": (
        "Whimsical Cosmere-flavored Pinet identities with Mistborn, "
        "Stormlight, and Isles-of-the-Emberdark fan service: agents, "
        "spren, oaths, artifacts, places, and inside jokes. "
        "Static authored characters, no LLM calls in startup or join."
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
        "idle": "holding oath",
        "working": "invested",
        "healthy": "stormlight bright",
        "stale": "crem settling",
        "ghost": "lost in the mists",
        "resumable": "sphere recharged",
    },
}

for entry in BROKERS:
    if len(entry) == 5:
        key, name, emoji, persona, style = entry
    else:
        key, name, emoji, persona = entry
        style = ["measured", "civic"]
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

with open("slack-bridge/skins/oathgate.json", "w", encoding="utf-8") as fh:
    json.dump(descriptor, fh, indent=2, ensure_ascii=False)
    fh.write("\n")

print(
    f"wrote oathgate.json: {len(BROKERS)} brokers, {len(WORKERS)} workers, "
    f"{len(worker_seen)} unique workers / 300 deterministic seeds."
)
