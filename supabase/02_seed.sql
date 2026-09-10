-- WARNING, read before running this again.
-- These inserts used to end in `on conflict (number) do update set title, body_html`,
-- which meant re-running this file silently overwrote stages 1-4 with the text
-- below, destroying anything written in the stage editor since. They are now
-- `do nothing`: safe to re-run, and it will not touch a stage that exists.
-- To genuinely reset a stage to the text below, delete that stage row first.

-- The Great Literary Hunt — content seed
-- Stages I–IV are written out in full. V–X are stubs: they depend on your
-- building, your library and what your classes have actually studied, so I
-- have left the shape and filled in instructions rather than invent content.
--
-- HONEYPOT RULE: only add a honeypot answer when a wrong answer is one a
-- machine would confidently produce and a thinking student would not. If a
-- student could plausibly arrive at it by honest reasoning, it is not a
-- honeypot — it is an unfair trap, and you will end up defending it to a
-- parent. Several stages below deliberately have none.

insert into public.settings (id, opens_at, closes_at, frozen, leaderboard_on)
values (1, null, null, false, true)
on conflict (id) do nothing;

-- ===========================================================================
-- I — The Shelf Mark   (off-screen input: the strongest device you have)
-- ===========================================================================
insert into public.stages (number, title, subtitle, body_html, kind, min_seconds) values
(1, 'The Shelf Mark', 'Nothing on this screen will help you',
$$<p>The hunt begins away from the screen.</p>
<p>In the library there are four copies of the same edition, shelved together
and marked with a green band. Find one.</p>
<p class="ref">Page 87 &middot; line 12 &middot; the fourth word</p>
<p>That word is your password. Spelling matters; punctuation does not.</p>
<p class="aside">There is no digital copy of this edition. There is no point
looking for one.</p>$$, 'text', 60)
on conflict (number) do nothing;   -- never overwrite an authored stage

insert into public.stage_answers (stage_number, normalised, is_honeypot, note) values
(1, 'REPLACEME', false, null);   -- <<< set this to public.norm('yourword')

-- ===========================================================================
-- II — The Corrupted Manuscript   (original text: unsearchable, untrainable)
-- ===========================================================================
insert into public.stages (number, title, subtitle, body_html, kind, min_seconds) values
(2, 'The Corrupted Manuscript', 'Six words have been eaten away',
$$<p>The verse below survives in one copy only. Damp has taken six words.
Restore them. Metre and rhyme will tell you what belongs.</p>
<div class="verse">
<p>The lamp burns low, the shutters <span class="gap">1</span>,<br>
No traveller ascends the <span class="gap">2</span>;<br>
The keeper counts the winters <span class="gap">3</span><br>
And sets his own among them <span class="gap">4</span>.</p>
<p>He does not grudge the guttered <span class="gap">5</span>,<br>
Nor bid the early darkness <span class="gap">6</span>;<br>
He writes each traveller&rsquo;s name<br>
And knows that none will come so late.</p>
</div>
<p>Enter the six words in order, separated by spaces.</p>$$, 'text', 120)
on conflict (number) do nothing;   -- never overwrite an authored stage

insert into public.stage_answers (stage_number, normalised, is_honeypot, note) values
(2, public.norm('fast stair past there flame wait'), false, null);
-- No honeypot here on purpose: several near-misses are honest human answers.

-- ===========================================================================
-- III — The Unreliable Witness   (deduction; one defensible honeypot)
-- ===========================================================================
insert into public.stages (number, title, subtitle, body_html, kind, min_seconds) values
(3, 'The Unreliable Witness', 'One account holds together. Three do not.',
$$<p>A folio went missing from the reading room. Four people gave accounts.
Exactly one account contradicts nothing it says itself. The other three each
contain an impossibility &mdash; not a lie about character, but about time or
place.</p>

<p class="who">Halloway, the porter</p>
<p>&ldquo;I locked the reading room the moment the clock struck four, as I do
every day, and took the key to the lodge. I saw Dunn come out through that
same door at about ten past, carrying nothing.&rdquo;</p>

<p class="who">Miss Ferrers, the librarian</p>
<p>&ldquo;I heard the clock strike four as I was leaving. I stood talking to
Dunn about a quarter of an hour after that, on the front steps, and then walked
to the station and caught the ten-past-four train.&rdquo;</p>

<p class="who">Dunn, a student</p>
<p>&ldquo;I left the reading room a little before four and stood on the steps.
Miss Ferrers came out and we talked until she hurried off for her train. I did
not go back in.&rdquo;</p>

<p class="who">Mrs Sowerby, who cleans</p>
<p>&ldquo;I swept the reading room at half past four and the folio was still
lying on the table then. The room had been locked since four and I have never
had a key to it.&rdquo;</p>

<p>Whose account holds? Enter the surname.</p>$$, 'text', 90)
on conflict (number) do nothing;   -- never overwrite an authored stage

insert into public.stage_answers (stage_number, normalised, is_honeypot, note) values
(3, public.norm('Dunn'), false, null),
(3, public.norm('Sowerby'), true,
   'Sowerby is the most circumstantially detailed account and the usual first guess of a summariser that has not tracked the key.');

-- ===========================================================================
-- IV — The Locked Library   (interactive grid; verified unique solution)
-- ===========================================================================
insert into public.stages (number, title, subtitle, body_html, kind, payload, min_seconds) values
(4, 'The Locked Library', 'Five volumes, five shelves, five borrowers',
$$<p>Five volumes stand in a row, shelf 1 on the left. Use the constraints to
place every author, decade and borrower.</p>
<p>When the grid is complete, read the borrowers from shelf 1 to shelf 5 and
enter the first letter of each surname, in order, as one word of five letters.</p>$$,
'grid',
$$
{
  "categories": {
    "Shelf": ["1","2","3","4","5"],
    "Author": ["Bronte","Gaskell","Trollope","Eliot","Hardy"],
    "Decade": ["1840s","1850s","1860s","1870s","1880s"],
    "Borrower": ["Kerr","Vance","Prynne","Hale","Osgood"]
  },
  "clues": [
    "Prynne borrowed the volume two shelves to the right of Osgood's.",
    "Kerr borrowed Gaskell.",
    "Eliot's volume is older than Bronte's.",
    "The 1880s volume stands on shelf 1.",
    "Vance borrowed Eliot.",
    "Hale's volume is from the 1840s.",
    "Hardy and Bronte are not adjacent.",
    "Hardy and Trollope are not adjacent.",
    "Osgood's volume is from the 1850s."
  ]
}
$$::jsonb, 240)
on conflict (number) do nothing;   -- never overwrite an authored stage

insert into public.stage_answers (stage_number, normalised, is_honeypot, note) values
(4, public.norm('KOVPH'), false, null);
-- Solution: 1 Gaskell 1880s Kerr | 2 Hardy 1850s Osgood | 3 Eliot 1860s Vance
--           4 Bronte 1870s Prynne | 5 Trollope 1840s Hale

-- ===========================================================================
-- V–X — stubs. Fill these in.
-- ===========================================================================
insert into public.stages (number, title, subtitle, body_html, kind, min_seconds) values
(5,  'The House Catalogue', 'Somewhere in this building',
     '<p>Replace this with a question answerable only by walking somewhere in the school: wording on a plaque, names on an honour board, titles in a display case, the number above a door.</p>', 'text', 120),
(6,  'The Keyword Cipher', 'The key is not on this page',
     '<p>Paste your Vigenere ciphertext here. Put the keyword on a poster in a corridor. The ciphertext can be shared freely; without the key it is useless.</p>', 'text', 180),
(7,  'The Marginalia', 'Three hands, one error',
     '<p>Replace this with an image of an annotated page carrying three contradictory annotations. Make the wrong annotator the one whose claim matches received critical opinion, and store that received opinion as a honeypot.</p>', 'text', 150),
(8,  'The Chronology', 'What we actually read this year',
     '<p>Order eight events from texts your classes have studied, including at least two discussed only in your lessons. The password is the resulting eight-digit string.</p>', 'text', 120),
(9,  'The Ledger', 'Everything you have collected so far',
     '<p>Take a specified character from each of the first eight passwords, in order. No team that has been given answers by another team can complete this.</p>', 'text', 60),
(10, 'The Final Manuscript', '',
     '<p>A longer original passage alluding to every earlier stage. Requires the ledger string and the item collected at Stage V.</p>', 'text', 300)
on conflict (number) do nothing;

insert into public.stage_answers (stage_number, normalised, is_honeypot, note) values
(5,'REPLACEME',false,null),(6,'REPLACEME',false,null),(7,'REPLACEME',false,null),
(8,'REPLACEME',false,null),(9,'REPLACEME',false,null),(10,'REPLACEME',false,null);
