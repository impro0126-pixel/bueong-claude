# Budget Notebook × Claude

[한국어](README.md)

The connector for [Budget Notebook](https://apps.apple.com/app/id6811481053)'s **Claude Link**.

Share card or bank screenshots with Claude, and Claude reads the transactions, categorizes them and puts them in Budget Notebook's **Inbox**. Open the Inbox in the app and apply the ones you want — that's it.

## What you need

- A Mac
- The [Claude desktop app](https://claude.ai/download) — the free plan works.
- Budget Notebook for Mac — **open it once** on your Mac and turn on Settings → **Claude Link**.
- **iCloud Drive turned on (required)** — System Settings → Apple Account → iCloud. If it's off, macOS blocks Claude from reading Budget Notebook's data.

It doesn't work with an iPhone alone: Claude places a file in Budget Notebook's folder on the Mac, so a Mac is needed. Transactions added on the Mac show up on your iPhone through iCloud.

## Install

1. **[Download bueong.mcpb](https://github.com/impro0126-pixel/bueong-claude/releases/latest/download/bueong.mcpb)**
2. Double-click the file. The Claude app opens with an install screen.
3. Click **Install**.

If double-clicking doesn't open it, drag the file onto Claude app → Settings → Extensions.

The install screen shows red warnings (access to everything on your computer, not verified by Anthropic). They always appear for extensions shared directly rather than through a reviewed directory. What this connector actually reads and writes is listed under "Where does my data go?" below.

The connector follows Budget Notebook's language: if the app shows English, Claude gets English instructions. After changing the app's language, quit and reopen the Claude app (⌘Q).

## Using it

1. In the Claude app's **Chat**, start a new conversation, share card or bank screenshots and say "Add these to my budget". The extension isn't available in the Claude Code screen.
2. Claude reads the card, account and category names registered in Budget Notebook and categorizes with those names. The first time, it asks which card you use most.
3. Open the Inbox in Budget Notebook, check, and apply.
   - Mac: the **⊕ (Add) menu → Inbox** at the top of the Write screen
   - iPhone: the Inbox button at the top left of the Write screen

When you add a bank screenshot, Claude also sends the account balance, so the top of the Inbox can confirm that the balance matches — a quick way to spot missing or duplicated transactions.

You can also ask things like "How much did I spend on food this month?" Claude reads Budget Notebook's transactions to answer.

Not sure what to ask? In the chat box, choose **＋ → Connectors → Add from Budget Notebook**: "Process screenshots", "This month's spending" and "First-time setup". The Budget Notebook switch in the same connector list must be on for Claude to use the tools.

### Take screenshots on iPhone and send them to Claude on the Mac

1. On iPhone, turn on Budget Notebook → Settings → **Claude Link**, open **Link Status** below it, and under **How to Add Screenshots** choose **Send to Claude on Mac**.
2. Pick screenshots on the Write screen and send them. You can add a one-line note ("this was a team dinner").
3. In Claude chat on the Mac, say "Process my screenshots". Claude reads them and puts them in the Inbox, and the iPhone shows **Processed on Mac** for the ones it added.

Screenshots travel to the Mac through iCloud Drive, so it must be on for both the iPhone and the Mac.

## Where does my data go?

- The connector runs only on your Mac. There's no server of ours, and your budget data isn't sent over the internet.
- It reaches the internet for **one** thing: once a day it checks GitHub for **the latest version number** of this connector. If there's a newer one, Claude tells you. To turn it off, go to Claude app → Settings → Extensions → Budget Notebook and turn off **새 판 확인** (update check — this one label stays in Korean, as the extension format can't translate setting names). If you installed it by hand, set the `BUEONG_UPDATE_CHECK=off` environment variable.
- Claude **writes** to two places:
  - The Inbox (`inbox.json`) in Budget Notebook's iCloud Drive folder — you choose in the app what goes into your budget.
  - The main cards and merchant rules Claude remembers — in your Mac's `Library/Application Support/kakeibo-mcp/` folder.
  - Finished iPhone screenshots are moved to `captures/처리됨/` in the same folder (not deleted). The folder name is fixed because the iPhone app looks for it.
- Claude **reads** the **names** of registered cards, accounts and categories, the **transactions** for the period you ask about, and the **screenshots** sent from iPhone. What it reads goes into that Claude conversation (the same as sharing a screenshot). It doesn't read account balances or investment principal.
- If you don't want it to read, turn off Claude Link in Budget Notebook on the Mac. The copy Claude was reading is deleted.

## Troubleshooting

- **The Inbox is empty, or Claude says there's no snapshot** → Open Budget Notebook on the Mac and check that Settings → Claude Link is on. After turning it on, keep the app open once.
- **Claude says macOS blocked folder access** → iCloud Drive is off on that Mac. Turn on iCloud Drive and quit and reopen Budget Notebook.
- **Claude can't find the tools** → Check that Budget Notebook is on in Claude app → Settings → Extensions, then quit the Claude app completely and reopen it. If you asked in Claude Code rather than Chat, ask again in Chat.
- **Claude answers in Korean** → The app was showing Korean when the connector started. Set Budget Notebook's language to English (iPhone: Settings → Display → Language; Mac: Settings → View → Language), open Budget Notebook on the Mac once, then quit and reopen the Claude app.

## Updating and removing

- **Updating**: when Claude says a new version is available, download a new file with "Download bueong.mcpb" above, double-click to install it again, then **quit the Claude app completely and reopen it (⌘Q)**. Until then, Chat only knows the old version's features. If installing fails, remove it as below and install fresh. Either way, the cards and merchant rules Claude remembers are stored separately from the extension and stay.
- **Removing**: Claude app → Settings → Extensions → Budget Notebook → Uninstall.

## Using it with Claude Code or installing by hand

It's a single file with no dependencies (`bueong-mcp.js`), so all you need is Node.js 18 or later.

```bash
git clone https://github.com/impro0126-pixel/bueong-claude.git "$HOME/bueong-claude"
```

```bash
claude mcp add bueong -- node "$HOME/bueong-claude/bueong-mcp.js"
```

To add it to Claude desktop by hand, go to Settings → Developer → Edit Config and add the following to `claude_desktop_config.json` (`name` is your Mac user name). If you've already installed the extension above, the same tools appear twice, so use only one.

```json
{
  "mcpServers": {
    "bueong": {
      "command": "node",
      "args": ["/Users/name/bueong-claude/bueong-mcp.js"]
    }
  }
}
```

If you use Claude Code, put this repository's [`CLAUDE.en.md`](CLAUDE.en.md) in your budget folder as `CLAUDE.md` so Claude follows the categorizing rules more closely. The connector looks at Budget Notebook's iCloud Drive folder first and, if it isn't there, at the app's own folder (`~/Library/Containers/com.bueong.app/Data/Documents`). To use a different location, set the `BUEONG_DIR` environment variable. To force a language, set `BUEONG_LANG` to `en` or `ko`.

## Tools

| Tool | What it does |
|---|---|
| `get_names` | Read the account, card and category names registered in Budget Notebook |
| `get_transactions` | Read Budget Notebook transactions for a period |
| `get_captures` | Get screenshots sent from iPhone as images (3 at a time) |
| `finish_captures` | Move screenshots whose transactions are added to processed |
| `get_config` | Read the main cards and merchant rules Claude remembers |
| `set_config` | Save what Claude remembers (in your Mac's `Library/Application Support/kakeibo-mcp/`) |
| `add_transactions` | Put transactions, balances and card totals in the Inbox |
