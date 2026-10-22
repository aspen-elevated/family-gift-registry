# Maintaining the kit

This repo is generated. The source lives in the private family repo; `tools/build-kit.py` there writes this folder (no family data, generic demo, empty `config.js`).

## Publish an update
1. In the source repo: `python3 tools/build-kit.py ../family-gift-registry`
2. Commit and push this repo. GitHub Pages updates the shared site in a minute or two, for every family using it.
3. If `Code.gs` or `Core.js` changed, tell families to paste the new files and deploy a new version (README → *Updating to a newer version*).

## One-time setup
- **Settings → Pages:** branch `main`, folder `/ (root)`. The shared site is `https://aspen-elevated.github.io/family-gift-registry/`.
- **Settings → General → Template repository:** on, so families can click *Use this template*.

## The "Make a copy" template Sheet (recommended)
Saves other families the copy-and-paste step:
1. Make a new blank Google Sheet named **Gift Registry (template)**. Don't run setup in it.
2. **Extensions → Apps Script:** paste `Code.gs`, add a `Core` script with `Core.js`, replace `appsscript.json` (as in the README). Save.
3. **Share → General access → Anyone with the link → Viewer.**
4. Copy the share link and change the ending `/edit?usp=sharing` to `/copy`. That link opens a **Make a copy** page with the script included.
5. Send that link to families (or add it to the README's step 1). Update the template's script when you publish a new version.
