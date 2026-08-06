# Self-hosted fonts

These fonts are bundled and served same-origin so app boot never depends on a
slow or unreachable third-party font host. Previously the UI loaded them via a
render-blocking `<link>` to Google Fonts, which could stall the entire app boot
when that host was slow.

## Fonts

| Family      | Weights         | Subsets          | License        |
| ----------- | --------------- | ---------------- | -------------- |
| Public Sans | 400/500/600/700 | latin, latin-ext | SIL OFL 1.1    |
| Spectral    | 500/600/700     | latin, latin-ext | SIL OFL 1.1    |

Public Sans is a variable font, so weights 400-700 share a single woff2 file per
subset. Spectral ships one file per weight per subset.

The cyrillic and vietnamese subsets that Google Fonts serves were dropped; this
app only renders latin text.

## Licenses

Both families are licensed under the SIL Open Font License, Version 1.1. The
full license text and copyright notices are included alongside the font files:

- `OFL-Public-Sans.txt` — Copyright 2015 The Public Sans Project Authors
- `OFL-Spectral.txt` — Copyright 2017 The Spectral Project Authors

The OFL permits free use, embedding, and redistribution (including in
commercial products) provided the license and copyright notices travel with the
font files, the fonts are not sold on their own, and any modified version is not
distributed under the reserved font names. These files are unmodified.

## Updating

The woff2 files and `fonts.css` were generated from the Google Fonts CSS API.
Filenames are suffixed with a short hash of the source URL so distinct physical
files never collide. When regenerating, keep these license files in place.
