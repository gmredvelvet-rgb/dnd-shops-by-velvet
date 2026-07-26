# D&D Shops: RPG Interactive Markets

**An RPG-inspired interactive shop interface for D&D 5e on Foundry VTT.** Turn any actor into a merchant with a browsable storefront: stock with quantities, themes, and buying that moves real items between real actors.

[![Foundry v14](https://img.shields.io/badge/Foundry-v13.347%2B-informational)](https://foundryvtt.com/)
[![System: dnd5e](https://img.shields.io/badge/system-dnd5e-red)](https://github.com/foundryvtt/dnd5e)
[![License: Proprietary](https://img.shields.io/badge/license-Proprietary%20(Patreon)-red)](#licensing)

> ⚠️ **Installation note:** the module folder must be named `dnd-shops` — Foundry requires the folder name to match the module id. Installing from the manifest URL handles this automatically.

---

## Requirements

| Requirement | Detail |
|---|---|
| Foundry VTT | **v13.347** minimum, **v14** verified. |
| Game system | **D&D 5e** (`dnd5e`). |
| Subscription | An **active, qualifying Patreon** subscription to [GM RedVelvet](https://www.patreon.com/gmredvelvet), for as long as you use the module — see [Licensing](#licensing). Only the **GM** authorises; players never see a prompt. |
| Internet | Required while playing. The licence is verified periodically against a licence server. |

## Installation

1. In Foundry, open **Add-on Modules → Install Module**.
2. Paste the **manifest URL** into the *Manifest URL* field:
   ```
   https://github.com/gmredvelvet-rgb/dnd-shops-by-velvet/releases/latest/download/module.json
   ```
3. Click **Install**, then enable **D&D Shops** in your world's *Manage Modules*.

## Usage

Open any actor sheet and use the **shop button in the sheet header** to open its storefront. Stock is kept per actor, so every merchant keeps its own inventory, and quantity steppers let you adjust or remove lines directly in the shop view.

## Settings

| Setting | Purpose |
|---|---|
| Default shop | The actor used when no specific shop is targeted |
| Theme | Visual theme for the storefront |
| Stock | Per-shop stock data |

## Licensing

D&D Shops requires an active, qualifying **Patreon** subscription to [GM RedVelvet](https://www.patreon.com/gmredvelvet).

**Only the GM authorises.** On their first load the GM is prompted to connect their Patreon account, which unlocks the module for everyone in the world. Players never see a prompt and never need an account of their own. If popups are blocked — common on phones — use the **auth-code** flow instead: connect on any device, copy the code, and paste it in.

### What happens if the subscription lapses

**Please read this before subscribing.** This is a subscription, not a one-off purchase, and the module re-checks it periodically against a licence server. Plainly:

- **If the subscription lapses, the module stops working.** The shop interface is no longer available.
- **Nothing else is affected.** Foundry, your world, your actors, your items and your settings are untouched. Your merchants remain ordinary actors and their items remain ordinary items — everything is still there through the normal D&D 5e sheet. No data is altered, withheld or lost, and no content becomes unopenable. Resubscribing turns it straight back on.
- **An internet connection is required while playing.** Verification is periodic, so a client that cannot reach the licence server deactivates the module until it can. Fully offline or air-gapped games are not supported.

If a perpetual licence is what you need, this is not that today. I would rather say so here than have anyone find out mid-campaign.

## FAQ

**Do my players need their own subscription?**
No. Only the GM authorises, and that unlocks the world for everyone connected.

**If I stop subscribing, do I lose my shops?**
No. Shop stock is stored in your world's settings and your merchants are ordinary actors — nothing is deleted. Only the interface stops opening, and resubscribing brings it straight back.

**Can I use it offline?**
No. The licence is verified periodically over the internet, and a client that cannot reach the licence server deactivates the module until it can.

## Author

**GM RedVelvet** · [Patreon](https://www.patreon.com/gmredvelvet) · Discord: `gmredvelvet`
