# Family Gift Registry

A private gift registry for your family, for holidays, birthdays and everything in between.

- **Givers pledge, you buy.** Grandparents, aunts and uncles pledge gifts. You do the buying, so things come from the stores you trust, with your memberships and warranties, at the best price you can find. They pay you back, or pay up front: their choice.
- **No scoreboard.** Only the organizers (usually the parents) see who pledged what. Everyone else just sees *Available*, *Partly pledged* or *Fully pledged*.
- **Group gifts** for the big things: anyone can chip in any amount.
- **Price watching:** sale alerts, a weekly spot-check email, Google price-drop emails read automatically, and a 14-day watch after you buy so you can ask for a price adjustment.
- **Kids' view:** the kids can see their wish list, never what's been pledged.
- Works on phones and can be added to the home screen like an app.

**Cost:** free. **You need:** a Google account (Gmail is fine). **Time:** about 20 minutes.
Everything is stored in a Google Sheet that you own. Nobody else, including whoever shared this with you, can see your family's data.

**[Look around the demo](https://aspen-elevated.github.io/family-gift-registry/?demo=1)** (every demo PIN is `1234`).

---

## Set it up

### 1. Get your copy of the registry Sheet

**If someone sent you a "Make a copy" link for the registry template,** open it, click **Make a copy**, and skip to step 2.

Otherwise, build it yourself (about 5 minutes):
1. In Google Drive, create a blank Google Sheet. Name it something like *Our Gift Registry*.
2. **Extensions → Apps Script**.
3. Replace everything in `Code.gs` with the contents of [`apps-script/Code.gs`](apps-script/Code.gs) (open it here, click the **Copy raw file** button, paste).
4. Click **+** next to *Files* → **Script**, name it `Core`, and paste in [`apps-script/Core.js`](apps-script/Core.js).
5. Click the gear (**Project Settings**) on the left and tick **Show "appsscript.json" manifest file in editor**. Back in the editor, open the existing `appsscript.json` file and replace its contents with [`apps-script/appsscript.json`](apps-script/appsscript.json). (Edit the existing file. Don't add a new script for it.)
6. Save (⌘S / Ctrl+S) and close the Apps Script tab.

### 2. Set up your family
1. Reload the Sheet. A **Gift Registry** menu appears next to *Help* (it can take a few seconds).
2. **Gift Registry → Set up our family.**
3. Google asks for permission the first time. It's your own script, so Google shows a warning: click **Advanced → Go to (your project) (unsafe)**, then **Allow**. It needs your Sheet, your Drive (for item photos), sending email (pledge receipts and alerts), reading price-drop emails, and checking store prices.
4. Answer the questions: your family name, the organizers (you and your spouse or partner), each with a PIN, the kids' names, and the stores you buy through.

### 3. Publish it
1. **Extensions → Apps Script.**
2. **Deploy → New deployment** → gear icon → **Web app**.
3. *Execute as:* **Me**. *Who has access:* **Anyone**.
4. **Deploy.** Approve the permissions again if asked.

"Anyone" lets your family open the registry from any phone or computer without a Google sign-in. Every request still needs a name and PIN.

### 4. Invite the family
1. Back in the Sheet: **Gift Registry → Show our registry links.**
2. Add your givers on the registry's **People** page (grandparents, aunts, uncles), each with a PIN, or with **Gift Registry → Add a person**.
3. Send each person their link by email and their PIN separately (a text works well). The link opens the registry with their name already picked.

### 5. Add gifts
Sign in as an organizer, then **Manage items → + Add item**. Paste a product link and it fills in what it can. Some stores block that, so type the details in. The **+ Add to registry** bookmark button (bottom of *Manage items*) fills in items straight from any store page on a computer.

---

## Day to day

| Need to… | Do this |
|---|---|
| Add a giver | **People → + Add person**, then **Copy link** |
| Someone forgot their PIN | **People → Edit → New PIN** |
| Same item for another kid, size or color | **Copy** on the item, or **Add & make a copy** in the item form |
| Buy a pledged item | **Manage items → Mark bought**: givers get the final price and their share by email |
| Record a payment | **Pledges & money** → tick **Paid** |
| Gift opened | **Mark given**, then the giver shows on **Thank-yous** |
| Hide pledges on your own items | Your name (top right) → **Surprise mode** |
| Change wording, stores, who gifts can be for | **Settings** |

**Prices at stores that block automatic checks** (REI, Scheels and others block them): turn on Google's **Track price** for an item while signed in with the Google account that owns the Sheet. The registry reads Google's price-drop emails every hour. Or click **Update** on the **Price alerts** page to record today's price yourself. A Monday email lists what to spot-check.

## Updating to a newer version
Paste the new `Code.gs` and `Core.js` over the old ones, save, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The web address doesn't change. If the update notes say so, run **Gift Registry → Set up our family** once more; it's safe to re-run and won't duplicate anyone.

## Running your own copy of the website (optional)
Most families use the shared site. To run your own: click **Use this template** on this page to create your own repository, put your web app URL in `config.js` (`API_URL`) and set `KIT: false`, then turn on **Settings → Pages** (branch `main`, root). Then set **Settings → Site address** in the registry to your new site.

## Privacy
- Your registry's data lives only in your Google Sheet and your Google account.
- The shared website is plain files on GitHub. It talks directly to *your* Apps Script and stores nothing.
- PINs are stored scrambled (hashed), never in plain text.
- Price-drop emails: the script only searches for those emails and keeps just the subject line and what it matched.
