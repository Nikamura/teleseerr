# Teleseerr interface

Teleseerr is a personal cinema library inside Telegram. Artwork leads browsing;
requests and download tools describe their actual state. Administration has its
own People destination rather than competing with movie categories.

## Navigation

Mobile has a fixed bottom navigation: Discover, Requests, People (admin only),
and You. Discover contains the For you, Movies, TV shows and Anime categories.
All destinations fit without horizontal scrolling. Desktop moves the same
navigation to the masthead. Detail pages retain Back and the existing request
confirmation bar. A navigation change stops hidden progress polling.

## Visual language

Use the system sans-serif stack, warm charcoal/ivory neutrals and one amber
interaction accent. Light Telegram themes use warm off-white with a darker
amber for readable links. Green and warning tones describe status, not arbitrary
brand accents. Keep text labels alongside status colors and icons.

Use 8px action corners, 10–12px artwork/inputs, 14–16px containers, and circles
only for avatars, switches and the featured-title opener. Use the outline SVG
icons in `web/icons.js`; keep emoji out of interface chrome. Primary controls have a
44px minimum interaction target. Reduced-motion settings disable decoration.

The featured title is a real trending result and opens its details. It is not a
playback control. Use upstream poster/backdrop images with a readable image
scrim; generated concept art is not a runtime asset. Keep horizontal poster rows
top-aligned, with readable names and years below the artwork.

## People and actions

A person's readable name/email leads; Telegram IDs and unlink controls live in
Account details. Manage downloads is an explicit labelled switch with a pending
state and rollback on failure. The configured administrator's switch stays
disabled and enabled. Search filters linked members locally and has an explicit
no-results state. Destructive unlink still requires confirmation.

Keep request/approval, monitoring, downloading, import and availability distinct.
Season and episode actions share one expandable list. Do not replace server
permission checks with visual hiding, and do not interpret request acceptance as
a completed download or repair.

## Validation

The facelift was inspected in the shared Chromium preview at 320×740, 430×932
and 1440×1000 with isolated demo API responses, including light/dark People,
long emails, no matches, permission success/rollback, browsing, title Back,
profile navigation and a season-request submission. These checks do not establish
production or native Telegram end-to-end behavior. Development-only captures and
the source-hashed receipt are kept outside public assets under `.design/facelift`.
No new runtime dependency was added.

## Routed navigation and analytics

Primary navigation uses real links and browser history: `/discover`, `/movies`,
`/tv`, `/anime`, `/requests`, `/people`, `/you`, plus `/movie/:id`, `/tv/:id` and
`/person/:id`. Browser Back/Forward and Telegram Back share one handler. Direct
links reload using root-relative assets; direct-entry Back returns to Discover.
Search terms stay in local history state rather than URL queries. Delayed detail
responses cannot render over a different current route.

Desktop navigation occupies its own opaque, sticky row above artwork, with a
small amber underline and readable inactive labels. Mobile keeps the opaque
bottom bar. Neither layout relies on poster contrast or a floating white pill.

The existing proxy-injected GoatCounter loader observes history changes. This
app opts into screen-only analytics: title/person IDs become aggregate detail
buckets, search terms and launch parameters are omitted, referrers keep only the
origin, and page titles contain no media/user data. Moving between different
titles still counts navigation; same-path refreshes do not duplicate it. Analytics
counts anonymous visitors/sessions, not identified Telegram accounts.

Headless browser fixtures exercised routing, Back/Forward, deep reload, profile,
People, search history privacy, person fallback and desktop/mobile layout. Captures
are under `.design/navigation`; these do not represent a native Telegram test.

Browse spacing: search and category tabs have an 18px separation. Category pages
leave 24px before the sort/filter row, 18px before genres and 24px before posters.
All four rows share a 20px horizontal gutter, reduced to 14px below 360px. Filter
controls retain 44px targets; genre/sort rows scroll horizontally on narrow screens.
Desktop search and category tabs span the full poster-grid content width; do not
reintroduce a fixed mobile-width cap inside the desktop layout.

## Responsive flow audit

The same interface is checked at narrow phones, wide phones, tablet widths,
desktop breakpoints and short landscape heights, in both themes. Tablet widths
600–899px use a wider canvas and four poster columns; narrow phones use two
columns, other phones three and desktop six. Poster titles and metadata sit
below the artwork, matching the home-page card language. Desktop genres wrap;
phone genres retain swipeable rows. Desktop detail posters/headings are larger,
request actions stay within the app width, and fixed bars reserve scroll space.

Dialogs use the active theme and viewport bounds, wrap long release names and
keep Close reachable while scrolling. Filters use a native dialog: bottom sheet
on phones and a bounded centered panel on larger screens, with Escape, focus
restoration and labelled inputs. Touch inputs use 16px type and 44px controls.
Profile identities wrap instead of clipping; cast and request titles are
keyboard-reachable. Login/unlinked screens hide browse controls.

One document scroller owns route restoration; dialogs lock background scrolling.
Pagination failures restore their action without skipping a page, stale filter
responses cannot replace newer results, and empty/error states stop skeletons
and provide recovery. These changes preserve API permissions and media behavior.
