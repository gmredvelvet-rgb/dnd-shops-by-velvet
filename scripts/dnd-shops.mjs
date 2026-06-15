/**
 * D&D Shops — v0.5.0
 * Fully-featured interactive shop for Foundry VTT + dnd5e
 *
 * Changes in v0.5.0:
 *  - Theme Selector: classic (default), oldschool (retro RPG parchment),
 *    and cyberpunk (neon sci-fi futuristic). Persisted in world settings.
 *  - Robust JSON import parser: handles nested structures, arrays of arrays,
 *    Foundry compendium exports, D&D Beyond exports, generic item lists,
 *    mismatched / alias item types, partial data gracefully, and now
 *    auto-categorizes items with richer subtype detection.
 *  - importedItemId now uses a deterministic hash so re-importing never
 *    creates duplicates even when source filenames differ.
 */

import { DndShopsLicenseClient, DndShopsLicenseUI } from './license-client.js';

const MODULE_ID      = "dnd-shops";
const COIN_VALUES    = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const SELLABLE_TYPES = new Set(["weapon","equipment","consumable","tool","loot","container","backpack"]);

/* Type aliases: handle common alternate names found in exported JSON */
const TYPE_ALIASES = {
  "armor"       : "equipment",
  "shield"      : "equipment",
  "gear"        : "equipment",
  "adventuring gear": "equipment",
  "ammunition"  : "consumable",
  "ammo"        : "consumable",
  "potion"      : "consumable",
  "poison"      : "consumable",
  "scroll"      : "consumable",
  "food"        : "consumable",
  "drink"       : "consumable",
  "rod"         : "weapon",
  "staff"       : "weapon",
  "wand"        : "weapon",
  "treasure"    : "loot",
  "trade good"  : "loot",
  "trade goods" : "loot",
  "trinket"     : "loot",
  "gem"         : "loot",
  "art"         : "loot",
  "junk"        : "loot",
  "pack"        : "container",
  "bag"         : "container",
  "chest"       : "container",
  "instrument"  : "tool",
  "artisan"     : "tool",
  "gaming set"  : "tool",
  "vehicle"     : "tool",
};

const THEMES = ["classic", "oldschool", "cyberpunk"];

let shopData;

/* ══════════════════════════════════════════════════════════════
   HOOKS
══════════════════════════════════════════════════════════════ */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "defaultShop", {
    name: "Default shop",
    scope: "world",
    config: false,
    type: String,
    default: "frenzy"
  });

  game.settings.register(MODULE_ID, "stock", {
    name: "Shop stock",
    scope: "world",
    config: false,
    type: Object,
    default: { items: [] }
  });

  game.settings.register(MODULE_ID, "shopDataCache", {
    name: "Shop data cache",
    scope: "world",
    config: false,
    type: Object,
    default: null
  });

  game.settings.register(MODULE_ID, "theme", {
    name: "Shop theme",
    scope: "client",
    config: false,
    type: String,
    default: "classic",
    choices: { classic: "Classic", oldschool: "Old School RPG", cyberpunk: "Cyberpunk Neon" }
  });

  game.keybindings.register(MODULE_ID, "openShop", {
    name    : game.i18n.localize("DNDSHOPS.Open"),
    editable: [{ key: "KeyB", modifiers: ["Shift"] }],
    onDown  : () => { game.dndShops.open(canvas?.tokens?.controlled?.[0]?.actor); return true; }
  });

  Handlebars.registerHelper("add", (a, b) => Number(a) + Number(b));
});

Hooks.once("ready", async () => {
  const license = DndShopsLicenseClient.instance;
  await license.initialize();

  if (game.user.isGM && !license.isLicensed) {
    DndShopsLicenseUI.show();
  }

  game.dndShops = {
    open: actor => {
      if (game.user.isGM && !DndShopsLicenseClient.instance.isLicensed) {
        DndShopsLicenseUI.show();
        return;
      }
      new DnDShopsApplication(actor).render(true);
    },
    reload: async () => {
      shopData = undefined;
      await loadShopData();
      ui.notifications.info("D&D Shops data reloaded.");
    },
    disconnect: async () => {
      await DndShopsLicenseClient.instance.releaseInstallation();
      shopData = undefined;
      await game.settings.set(MODULE_ID, "shopDataCache", null);
    }
  };
});

Hooks.on("getActorSheetHeaderButtons", (app, buttons) => {
  const actor = app.actor;
  if (!actor?.testUserPermission(game.user, "OWNER")) return;
  buttons.unshift({
    label  : game.i18n.localize("DNDSHOPS.Open"),
    class  : "dnd-shops-open",
    icon   : "fas fa-store",
    onclick: () => game.dndShops.open(actor)
  });
});

/* ══════════════════════════════════════════════════════════════
   APPLICATION
══════════════════════════════════════════════════════════════ */

class DnDShopsApplication extends Application {
  constructor(actor, options = {}) {
    super(options);
    this.actor      = actor ?? firstOwnedCharacter();
    this.mode       = "buy";
    this.category   = "weapon";
    this.query      = "";
    this.selectedId = null;
    this.cart       = new Map();
    this._listing   = [];
    this.theme      = game.settings.get(MODULE_ID, "theme") ?? "classic";
  }

  /* ── OPTIONS ────────────────────────────────────────────────── */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id       : "dnd-shops-app",
      title    : game.i18n.localize("DNDSHOPS.Title"),
      template : `${moduleBase()}/templates/shop.hbs`,
      width    : Math.min(window.innerWidth - 80, 1480),
      height   : Math.min(window.innerHeight - 80, 920),
      resizable: true,
      classes  : ["dnd-shops-window"],
      dragDrop : [{ dragSelector: null, dropSelector: ".dnd-shops-shell" }]
    });
  }

  /* ── DATA ───────────────────────────────────────────────────── */
  async getData() {
    const data = await loadShopData();
    if (!data) return { unlicensed: true };

    const actors = game.actors
      .filter(a => a.type === "character" && a.testUserPermission(game.user, "OWNER"))
      .map(a => ({ id: a.id, name: a.name, selected: a.id === this.actor?.id }));

    const categories = data.categories.map(cat => ({
      ...cat,
      selected: cat.id === this.category
    }));

    if (!categories.some(c => c.selected)) this.category = categories[0]?.id;

    const listing = this.mode === "buy"
      ? await this.#buyListing(data)
      : this.#sellListing(data);

    this._listing = listing;

    if (!listing.some(i => i.id === this.selectedId)) this.selectedId = listing[0]?.id ?? null;
    for (const item of listing) item.selected = item.id === this.selectedId;
    const selectedItem = listing.find(i => i.id === this.selectedId);

    const cart       = this.#cartRows(listing);
    const total      = cart.reduce((s, r) => s + r.lineCp, 0);
    const activeCategory = categories.find(c => c.id === this.category);

    /* Build theme options for the selector */
    const themeOptions = THEMES.map(t => ({
      id      : t,
      selected: t === this.theme,
      label   : game.i18n.localize(`DNDSHOPS.Theme_${t}`) ?? t
    }));

    return {
      shop        : data.shop,
      stars       : "★".repeat(data.shop.reputation) + "☆".repeat(Math.max(0, 10 - data.shop.reputation)),
      actors,
      mode        : this.mode,
      buyMode     : this.mode === "buy",
      sellMode    : this.mode === "sell",
      categories,
      activeCode  : this.mode === "buy" ? activeCategory?.code : "CTR",
      activeTitle : this.mode === "buy" ? activeCategory?.label : game.i18n.localize("DNDSHOPS.Sell"),
      query       : this.query,
      listing,
      resultCount : listing.length,
      selectedItem,
      cart,
      cartCount   : cart.reduce((s, r) => s + r.qty, 0),
      totalLabel  : formatCurrency(total),
      wallet      : formatCurrency(actorCurrencyCp(this.actor)),
      sellPercent : Math.round((data.shop.sellMultiplier ?? 0.5) * 100),
      isGM        : game.user.isGM,
      theme       : this.theme,
      themeOptions
    };
  }

  /* ── LISTENERS ──────────────────────────────────────────────── */
  activateListeners(html) {
    super.activateListeners(html);
    const el = html[0] ?? html;

    /* Unlicensed screen — connect button */
    el.querySelector("#dnd-shops-unlock-btn")?.addEventListener("click", async () => {
      const btn = el.querySelector("#dnd-shops-unlock-btn");
      btn.textContent = "Opening Patreon...";
      btn.disabled = true;
      try {
        const success = await DndShopsLicenseClient.instance.startOAuth();
        if (success) { shopData = undefined; this.render(); }
        else { btn.innerHTML = '<i class="fa-brands fa-patreon"></i> Connect Patreon'; btn.disabled = false; }
      } catch (e) {
        btn.innerHTML = '<i class="fa-brands fa-patreon"></i> Connect Patreon'; btn.disabled = false;
        ui.notifications?.error(`D&D Shops: ${e.message}`);
      }
    });

    if (el.querySelector(".dnd-shops-unlicensed-screen")) return;

    /* Apply theme class to shell */
    this.#applyTheme(el);

    el.querySelector("select[name='actor']")
      ?.addEventListener("change", e => {
        this.actor = game.actors.get(e.currentTarget.value);
        this.cart.clear();
        this.render();
      });

    /* Theme switcher */
    el.querySelectorAll(".dnd-shops-theme-btn").forEach(btn =>
      btn.addEventListener("click", async e => {
        const t = e.currentTarget.dataset.theme;
        if (!THEMES.includes(t)) return;
        this.theme = t;
        await game.settings.set(MODULE_ID, "theme", t);
        this.render();
      })
    );

    el.querySelectorAll(".dnd-shop-tab").forEach(btn =>
      btn.addEventListener("click", e => {
        this.mode = e.currentTarget.dataset.mode;
        this.selectedId = null;
        this.cart.clear();
        this.render();
      })
    );

    el.querySelectorAll(".dnd-shop-category").forEach(btn =>
      btn.addEventListener("click", e => {
        this.category = e.currentTarget.dataset.category;
        this.selectedId = null;
        this.cart.clear();
        this.render();
      })
    );

    el.querySelector(".dnd-shops-search-input")
      ?.addEventListener("input", e => {
        this.query = e.currentTarget.value;
        this.selectedId = null;
        this.render();
      });

    el.querySelector(".dnd-shops-search-clear")
      ?.addEventListener("click", () => {
        this.query = "";
        this.selectedId = null;
        this.render();
      });

    el.querySelectorAll(".dnd-shop-item").forEach(btn => {
      btn.addEventListener("click", e => {
        this.selectedId = e.currentTarget.dataset.id;
        this.render();
      });
      btn.addEventListener("dblclick", e => {
        this.#addToCart(e.currentTarget.dataset.id);
      });
    });

    el.querySelector(".dnd-shop-add")
      ?.addEventListener("click", () => {
        if (this.selectedId) this.#addToCart(this.selectedId);
      });

    /* Remove from shop — GM only */
    el.querySelector(".dnd-shop-remove")
      ?.addEventListener("click", () => {
        if (this.selectedId && game.user.isGM) this.#removeFromShop(this.selectedId);
      });

    el.querySelectorAll(".dnd-shops-cart-row .cart-btn, .cart-remove").forEach(btn => {
      btn.addEventListener("click", e => {
        const row    = e.currentTarget.closest(".dnd-shops-cart-row");
        const id     = row.dataset.id;
        const action = e.currentTarget.dataset.action;
        const qty    = this.cart.get(id) ?? 0;
        if (action === "remove") this.cart.delete(id);
        if (action === "inc")    this.cart.set(id, qty + 1);
        if (action === "dec")    qty <= 1 ? this.cart.delete(id) : this.cart.set(id, qty - 1);
        this.render();
      });
    });

    el.querySelector(".dnd-shop-confirm")
      ?.addEventListener("click", () => this.#confirm());

    el.querySelector(".dnd-shops-import-json")
      ?.addEventListener("click", () => el.querySelector(".dnd-shops-import-input")?.click());

    el.querySelector(".dnd-shops-import-input")
      ?.addEventListener("change", e => this.#importJsonFiles(e.currentTarget.files));

    /* GM-only: right-click to set stock */
    if (game.user.isGM) {
      el.querySelectorAll(".dnd-shop-item").forEach(btn => {
        btn.addEventListener("contextmenu", e => {
          e.preventDefault();
          this.#promptSetStock(e.currentTarget.dataset.id);
        });
      });
    }

    this.#bindKeyboard(el);
  }

  /* ── THEME ──────────────────────────────────────────────────── */
  #applyTheme(el) {
    const shell = el.querySelector(".dnd-shops-shell");
    if (!shell) return;
    shell.dataset.theme = this.theme;
  }

  /* ── KEYBOARD ───────────────────────────────────────────────── */
  #bindKeyboard(el) {
    const list = el.querySelector(".dnd-shops-list");
    if (!list) return;
    list.addEventListener("keydown", e => {
      const items = this._listing;
      if (!items.length) return;
      const idx = items.findIndex(i => i.id === this.selectedId);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.selectedId = items[Math.min(idx + 1, items.length - 1)].id;
        this.render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.selectedId = items[Math.max(idx - 1, 0)].id;
        this.render();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (this.selectedId) this.#addToCart(this.selectedId);
      }
    });
  }

  /* ── BUY LISTING ────────────────────────────────────────────── */
  async #buyListing(data) {
    const category   = data.categories.find(c => c.id === this.category) ?? data.categories[0];
    const stockItems = await loadStockItems(category.id, category);
    return this.#filter(
      stockItems.map((entry, idx) => normalizeCompendiumItem(entry, idx, this.actor))
    );
  }

  /* ── SELL LISTING ───────────────────────────────────────────── */
  #sellListing(data) {
    if (!this.actor) return [];
    const multiplier = data.shop.sellMultiplier ?? 0.5;
    const items = this.actor.items
      .filter(i => SELLABLE_TYPES.has(i.type) && (i.system?.quantity ?? 1) > 0)
      .map((i, idx) => normalizeActorItem(i, idx, multiplier));
    return this.#filter(items);
  }

  /* ── FILTER ─────────────────────────────────────────────────── */
  #filter(items) {
    const q = this.query.trim().toLocaleLowerCase();
    if (!q) return items;
    return items.filter(i => `${i.name} ${i.subtitle} ${i.type}`.toLocaleLowerCase().includes(q));
  }

  /* ── CART ROWS ──────────────────────────────────────────────── */
  #cartRows(listing) {
    return Array.from(this.cart.entries()).flatMap(([id, qty]) => {
      const item = listing.find(e => e.id === id);
      if (!item) return [];
      const max     = this.mode === "sell" ? item.owned : item.stock;
      const safeQty = max == null ? qty : Math.min(qty, max);
      if (safeQty !== qty) this.cart.set(id, safeQty);
      const lineCp = item.priceCp * safeQty;
      return [{ ...item, qty: safeQty, lineCp, lineLabel: formatCurrency(lineCp) }];
    });
  }

  /* ── ADD TO CART ────────────────────────────────────────────── */
  #addToCart(id) {
    const qty = this.cart.get(id) ?? 0;
    this.cart.set(id, qty + 1);
    this.#toast(game.i18n.localize("DNDSHOPS.AddedToCart"));
    this.render();
  }

  /* ── CONFIRM ────────────────────────────────────────────────── */
  async #confirm() {
    if (!this.actor)
      return this.#toast(game.i18n.localize("DNDSHOPS.NoActor"), "error");
    if (!this.actor.testUserPermission(game.user, "OWNER"))
      return this.#toast(game.i18n.localize("DNDSHOPS.NoPermission"), "error");

    const data    = await loadShopData();
    const listing = this.mode === "buy" ? await this.#buyListing(data) : this.#sellListing(data);
    const rows    = this.#cartRows(listing);
    if (!rows.length)
      return this.#toast(game.i18n.localize("DNDSHOPS.EmptyCart"), "error");

    if (this.mode === "buy") await this.#buy(rows, data);
    else await this.#sell(rows);
  }

  /* ── BUY ────────────────────────────────────────────────────── */
  async #buy(rows, data) {
    const total  = rows.reduce((s, r) => s + r.lineCp, 0);
    const wallet = actorCurrencyCp(this.actor);
    if (wallet < total)
      return this.#toast(game.i18n.localize("DNDSHOPS.NoFunds"), "error");

    await updateActorCurrency(this.actor, wallet - total);
    for (const row of rows) await addItemToActor(this.actor, row.raw, row.qty);

    /* Reduce stock quantities */
    const stock = getStock();
    for (const row of rows) {
      if (!row.id.startsWith("stock.")) continue;
      const stockId = row.id.replace(/^stock\./, "");
      const entry   = stock.items.find(e => stockEntryId(e) === stockId);
      if (entry && entry.stock != null) {
        entry.stock = Math.max(0, entry.stock - row.qty);
      }
    }
    await game.settings.set(MODULE_ID, "stock", stock);

    this.cart.clear();
    this.#toast(game.i18n.localize("DNDSHOPS.Purchased"));
    this.render();

    await showReceipt({
      actor  : this.actor,
      shop   : data.shop,
      rows,
      total,
      wallet,
      balance: wallet - total
    });
  }

  /* ── SELL ───────────────────────────────────────────────────── */
  async #sell(rows) {
    const total = rows.reduce((s, r) => s + r.lineCp, 0);
    await updateActorCurrency(this.actor, actorCurrencyCp(this.actor) + total);

    for (const row of rows) {
      const item     = this.actor.items.get(row.id);
      if (!item) continue;
      const quantity = item.system?.quantity ?? 1;
      if (quantity <= row.qty) await item.delete();
      else await item.update({ "system.quantity": quantity - row.qty });
    }

    this.cart.clear();
    this.#toast(game.i18n.localize("DNDSHOPS.Sold"));
    this.render();
  }

  /* ── JSON IMPORT (robust) ────────────────────────────────────── */
  async #importJsonFiles(files) {
    if (!game.user.isGM) return;
    if (!files?.length) return;

    const data  = await loadShopData();
    const stock = getStock();
    const stats = { added: 0, updated: 0, skipped: 0 };

    for (const file of files) {
      let payload;
      try {
        const text = await file.text();
        payload = JSON.parse(text);
      } catch (error) {
        console.error(`${MODULE_ID} | JSON parse failed:`, file.name, error);
        stats.skipped++;
        continue;
      }

      const source = detectSource(payload, file.name);
      const items  = extractImportItems(payload);

      if (!items.length) {
        console.warn(`${MODULE_ID} | No importable items in:`, file.name);
        stats.skipped++;
        continue;
      }

      for (const raw of items) {
        /* Normalize & resolve type aliases */
        const item = normalizeRawItem(raw);
        if (!item) { stats.skipped++; continue; }

        const itemData = sanitizeImportedItem(item);
        const category = categorizeItem(itemData, data.categories);
        const importId = importedItemId(source, itemData);

        const existing = stock.items.find(e =>
          e.importId === importId ||
          (!e.uuid && e.itemData?.name === itemData.name && e.itemData?.type === itemData.type)
        );

        const entry = {
          importId,
          category,
          stock   : null,
          rank    : rankFromItemData(itemData),
          price   : itemData.system?.price,
          itemData,
          source,
          addedAt : Date.now()
        };

        if (existing) {
          Object.assign(existing, entry, {
            addedAt  : existing.addedAt ?? entry.addedAt,
            updatedAt: Date.now()
          });
          stats.updated++;
        } else {
          stock.items.push(entry);
          stats.added++;
        }
      }
    }

    await game.settings.set(MODULE_ID, "stock", stock);
    this.cart.clear();
    this.selectedId = null;
    this.#toast(game.i18n.format("DNDSHOPS.ImportComplete", stats));
    this.render();
  }

  /* ── REMOVE FROM SHOP (GM only) ─────────────────────────────── */
  async #removeFromShop(id) {
    if (!game.user.isGM) return;
    const stockId = id.replace(/^stock\./, "");
    const stock   = getStock();
    stock.items   = stock.items.filter(e => stockEntryId(e) !== stockId || e.category !== this.category);
    await game.settings.set(MODULE_ID, "stock", stock);
    this.selectedId = null;
    this.#toast(game.i18n.localize("DNDSHOPS.ItemRemoved"));
    this.render();
  }

  /* ── SET STOCK (GM right-click) ──────────────────────────────── */
  async #promptSetStock(id) {
    if (!game.user.isGM) return;
    const stockId = id.replace(/^stock\./, "");
    const stock   = getStock();
    const entry   = stock.items.find(e => stockEntryId(e) === stockId);
    if (!entry) return;

    const current = entry.stock ?? "";
    const result  = await new Promise(resolve => {
      new Dialog({
        title  : game.i18n.localize("DNDSHOPS.SetStock"),
        content: `<div style="padding:12px">
            <label style="display:block;font-weight:900;margin-bottom:6px;">
              ${game.i18n.localize("DNDSHOPS.SetStock")} (blank = ∞)
            </label>
            <input type="number" min="0" value="${current}"
              style="width:100%;padding:6px;border:2px solid #333;"
              id="dnd-shops-stock-input" autofocus />
          </div>`,
        buttons: {
          ok    : { label: "OK",     callback: html => resolve(html.find("#dnd-shops-stock-input").val()) },
          cancel: { label: "Cancel", callback: ()   => resolve(null) }
        },
        default: "ok"
      }).render(true);
    });

    if (result === null) return;
    entry.stock = result.trim() === "" ? null : Math.max(0, parseInt(result) || 0);
    await game.settings.set(MODULE_ID, "stock", stock);
    this.#toast(game.i18n.localize("DNDSHOPS.StockSet"));
    this.render();
  }

  /* ── DRAG & DROP — GM ONLY ──────────────────────────────────── */
  async _onDrop(event) {
    if (!game.user.isGM) {
      this.#toast("Only the GM can add items to the shop.", "error");
      return;
    }

    const transfer = event.dataTransfer?.getData("text/plain");
    if (!transfer) return;
    this.element?.[0]?.classList?.remove?.("drag-over");

    let dropData;
    try { dropData = JSON.parse(transfer); }
    catch { return; }

    const uuid     = dropData.uuid
      ?? ((dropData.pack && dropData.id) ? `Compendium.${dropData.pack}.${dropData.id}` : null);
    const document = uuid ? await fromUuid(uuid) : null;

    if (document?.documentName !== "Item") {
      return this.#toast(game.i18n.localize("DNDSHOPS.DropItemOnly"), "error");
    }

    const stock = getStock();
    stock.items = stock.items.filter(e => e.uuid !== uuid || e.category !== this.category);
    stock.items.push({
      uuid,
      category: this.category,
      stock   : null,
      rank    : rankFromItem(document),
      addedAt : Date.now()
    });

    await game.settings.set(MODULE_ID, "stock", stock);
    this.selectedId = `stock.${uuid}`;
    this.#toast(game.i18n.localize("DNDSHOPS.ItemAdded"));
    this.render();
  }

  _onDragOver(event) {
    if (!game.user.isGM) return;
    event.preventDefault();
    this.element?.[0]?.classList?.add?.("drag-over");
  }

  _onDragLeave() {
    this.element?.[0]?.classList?.remove?.("drag-over");
  }

  /* ── TOAST HELPER ───────────────────────────────────────────── */
  #toast(msg, type = "ok") {
    const container = this.element?.[0]?.querySelector?.(".dnd-shops-toasts");
    if (!container) {
      type === "error"
        ? ui.notifications.error(msg)
        : ui.notifications.info(msg);
      return;
    }
    const el = document.createElement("div");
    el.className = `dnd-shops-toast${type === "error" ? " toast-error" : ""}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  async _renderInner(data) {
    const html = await super._renderInner(data);
    const shell = html[0]?.querySelector?.(".dnd-shops-shell");
    if (shell) {
      shell.addEventListener("dragover",  e => this._onDragOver(e));
      shell.addEventListener("dragleave", () => this._onDragLeave());
    }
    return html;
  }
}

/* ══════════════════════════════════════════════════════════════
   RECEIPT — popup + chat message
══════════════════════════════════════════════════════════════ */

async function showReceipt({ actor, shop, rows, total, wallet, balance }) {
  const orderId   = randomSku(actor.id + Date.now());
  const timestamp = new Date().toLocaleString();
  const localize  = key => game.i18n.localize(key);

  const itemRows = rows.map(r =>
    `<tr>
      <td><img src="${r.img}" style="width:24px;height:24px;border:none;vertical-align:middle;margin-right:6px;">${r.name}</td>
      <td style="text-align:center">${r.qty}</td>
      <td style="text-align:right">${formatCurrency(r.priceCp)}</td>
      <td style="text-align:right">${r.lineLabel}</td>
    </tr>`
  ).join("");

  const receiptHtml = `
<div class="dnd-shops-receipt">
  <div class="rcpt-header">
    <div class="rcpt-store">${shop.name}</div>
    <div class="rcpt-sub">${shop.subtitle}</div>
    <div class="rcpt-meta">
      <span>${shop.district}</span>
      <span>#${orderId}</span>
    </div>
    <div class="rcpt-date">${timestamp}</div>
  </div>
  <div class="rcpt-customer">
    <span class="rcpt-field">${localize("DNDSHOPS.Actor")}:</span>
    <strong>${actor.name}</strong>
  </div>
  <table class="rcpt-table">
    <thead>
      <tr>
        <th>${localize("DNDSHOPS.ReceiptOrder")}</th>
        <th style="text-align:center">${localize("DNDSHOPS.ReceiptQty")}</th>
        <th style="text-align:right">${localize("DNDSHOPS.ReceiptUnit")}</th>
        <th style="text-align:right">${localize("DNDSHOPS.ReceiptLine")}</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>
  <div class="rcpt-totals">
    <div class="rcpt-row">
      <span>${localize("DNDSHOPS.ReceiptPaid")}</span>
      <strong>${formatCurrency(total)}</strong>
    </div>
    <div class="rcpt-row rcpt-balance">
      <span>${localize("DNDSHOPS.ReceiptBalance")}</span>
      <strong>${formatCurrency(balance)}</strong>
    </div>
  </div>
  <div class="rcpt-footer">
    <div class="rcpt-barcode">▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌</div>
    <div class="rcpt-tagline">"${shop.keeperLine}"</div>
    <div class="rcpt-thanks">— ${shop.keeper}</div>
  </div>
</div>`;

  new Dialog({
    title  : localize("DNDSHOPS.Receipt"),
    content: receiptHtml,
    buttons: {
      close: {
        label: localize("DNDSHOPS.ReceiptClose"),
        icon : "<i class='fa-solid fa-xmark'></i>"
      }
    },
    default: "close",
    classes: ["dnd-shops-receipt-dialog"]
  }, {
    width : 460,
    height: "auto"
  }).render(true);

  const chatContent = `
<div class="dnd-shops-receipt-chat">
  <div class="rcpt-chat-title">
    <i class="fa-solid fa-receipt"></i>
    ${localize("DNDSHOPS.Receipt")} — ${shop.name}
  </div>
  ${receiptHtml}
</div>`;

  await ChatMessage.create({
    content : chatContent,
    speaker : ChatMessage.getSpeaker({ actor }),
    flags   : { [MODULE_ID]: { type: "receipt", orderId } },
    style   : CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0
  });
}

/* ══════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
══════════════════════════════════════════════════════════════ */

function firstOwnedCharacter() {
  return game.actors.find(a => a.type === "character" && a.testUserPermission(game.user, "OWNER"));
}

function moduleBase() {
  return game.modules.get(MODULE_ID)?.url ?? `modules/${MODULE_ID}`;
}

async function loadShopData() {
  if (shopData) return shopData;

  if (game.user.isGM) {
    const license = DndShopsLicenseClient.instance;
    if (license.isLicensed) {
      try {
        const data = await license.fetchShopData();
        shopData = data;
        await game.settings.set(MODULE_ID, "shopDataCache", data);
        return shopData;
      } catch (e) {
        console.error(`${MODULE_ID} | Failed to fetch shop data from server:`, e);
      }
    }
  }

  // Players (or GM fallback): read from world settings cached by the GM
  const cached = game.settings.get(MODULE_ID, "shopDataCache");
  if (cached?.categories?.length) {
    shopData = cached;
    return shopData;
  }

  return null;
}

function getStock() {
  const stock = foundry.utils.deepClone(game.settings.get(MODULE_ID, "stock") ?? { items: [] });
  stock.items ??= [];
  return stock;
}

/* ── STOCK ITEM LOADING ──────────────────────────────────────── */
async function loadStockItems(categoryId, category) {
  const entries = getStock().items.filter(e => e.category === categoryId);
  const loaded  = [];

  for (const entry of entries) {
    const document = entry.uuid ? await fromUuid(entry.uuid) : null;
    const itemData = entry.itemData ?? document?.toObject?.();
    if (!itemData?.name || !itemData?.type) continue;

    if (category?.itemTypes?.length) {
      const itemType = itemData.type;
      if (!category.itemTypes.includes(itemType)) continue;
    }

    if (categoryId === "ammunition") {
      if (itemSubtype(itemData) !== "ammo") continue;
    }

    if (categoryId === "magic") {
      const rarity = itemData.system?.rarity ?? "";
      if (!rarity || rarity === "") continue;
    }

    loaded.push({ ...entry, document, itemData });
  }

  return loaded;
}

/* ── NORMALIZE: COMPENDIUM ITEM ─────────────────────────────── */
function normalizeCompendiumItem(entry, index, actor) {
  const item        = entry.itemData ?? entry.document?.toObject?.();
  const priceCp     = priceToCp(entry.price ?? item.system?.price);
  const stockLabel  = entry.stock == null ? "∞" : String(entry.stock);
  const description = stripHtml(item.system?.description?.value) || "Fresh from the shelf.";

  return {
    id        : `stock.${stockEntryId(entry)}`,
    index,
    name      : item.name,
    subtitle  : description.slice(0, 80),
    description,
    img       : item.img,
    type      : item.type,
    rank      : entry.rank ?? rankFromItemData(item),
    priceCp,
    priceLabel: formatCurrency(priceCp),
    stock     : entry.stock,
    stockLabel,
    owned     : ownedQuantity(actor, item.name),
    sku       : randomSku(stockEntryId(entry)),
    raw       : foundry.utils.deepClone(item),
    selected  : false,
    canRemove : game.user.isGM
  };
}

/* ── NORMALIZE: ACTOR ITEM ──────────────────────────────────── */
function normalizeActorItem(item, index, multiplier) {
  const baseCp  = priceToCp(item.system?.price ?? { value: 0, denomination: "gp" });
  const priceCp = Math.max(1, Math.floor(baseCp * multiplier));
  const rarity  = item.system?.rarity;
  const ranks   = { common:"D", uncommon:"C", rare:"B", veryRare:"A", legendary:"S", artifact:"S" };

  return {
    id        : item.id,
    index,
    name      : item.name,
    subtitle  : stripHtml(item.system?.description?.value).slice(0, 80),
    description: stripHtml(item.system?.description?.value) || "Secondhand gear.",
    img       : item.img,
    type      : item.type,
    rank      : ranks[rarity] ?? "C",
    priceCp,
    priceLabel: formatCurrency(priceCp),
    stock     : item.system?.quantity ?? 1,
    stockLabel: String(item.system?.quantity ?? 1),
    owned     : item.system?.quantity ?? 1,
    sku       : item.id,
    raw       : item,
    selected  : false
  };
}

/* ── CURRENCY HELPERS ───────────────────────────────────────── */
function priceToCp(price = {}) {
  const value        = Number(price.value ?? 0);
  const denomination = price.denomination ?? "gp";
  return Math.max(0, Math.round(value * (COIN_VALUES[denomination] ?? 100)));
}

function actorCurrencyCp(actor) {
  const currency = actor?.system?.currency ?? {};
  return Object.entries(COIN_VALUES).reduce(
    (sum, [coin, value]) => sum + (Number(currency[coin] ?? 0) * value), 0
  );
}

async function updateActorCurrency(actor, totalCp) {
  const currency = cpToCurrency(totalCp);
  await actor.update({
    "system.currency.pp": currency.pp,
    "system.currency.gp": currency.gp,
    "system.currency.ep": currency.ep,
    "system.currency.sp": currency.sp,
    "system.currency.cp": currency.cp
  });
}

function cpToCurrency(cp) {
  let remaining = Math.max(0, Math.floor(cp));
  const currency = {};
  for (const [coin, value] of Object.entries(COIN_VALUES)) {
    currency[coin]  = Math.floor(remaining / value);
    remaining      -= currency[coin] * value;
  }
  return currency;
}

function formatCurrency(cp) {
  const currency = cpToCurrency(cp);
  const parts    = Object.entries(currency)
    .filter(([, v]) => v)
    .map(([coin, v]) => `${v}${coin}`);
  return parts.length ? parts.join(" ") : "0cp";
}

/* ── ITEM HELPERS ───────────────────────────────────────────── */
async function addItemToActor(actor, shopItem, qty) {
  const existing = actor.items.find(i => i.name === shopItem.name && i.type === shopItem.type);
  if (existing) {
    const quantity = Number(existing.system?.quantity ?? 1);
    return existing.update({ "system.quantity": quantity + qty });
  }

  const data = foundry.utils.deepClone(shopItem);
  delete data._id;
  delete data.rank;
  delete data.price;
  delete data.stock;
  delete data.description;
  data.system           ??= {};
  data.system.quantity    = qty;
  data.system.description ??= {};
  data.system.description.value ??= "";

  return actor.createEmbeddedDocuments("Item", [data]);
}

/* ══════════════════════════════════════════════════════════════
   ROBUST JSON IMPORT HELPERS
══════════════════════════════════════════════════════════════ */

/**
 * Detect the "source" identifier from a JSON payload or filename.
 * Used for deterministic importedItemId generation.
 */
function detectSource(payload, filename = "import") {
  return (
    payload?.package
    ?? payload?.metadata?.id
    ?? payload?.metadata?.name
    ?? payload?.id
    ?? payload?.name
    ?? filename.replace(/\.json$/i, "")
  );
}

/**
 * Deep-extract all item-like objects from any known JSON structure.
 * Handles:
 *  - Raw item object: { type, name, ... }
 *  - Array of items: [ {...}, {...} ]
 *  - Foundry export: { items: [...] }
 *  - Foundry compendium: { documents: [...] }
 *  - Nested arrays: { results: [ [...], [...] ] }
 *  - Adventure / world packs: { items: [...], actors: [...], ... }
 *  - D&D Beyond export: { character: { inventory: [...] } }
 *  - Roll20 / other: { handouts: [...], items: [...] }
 */
function extractImportItems(payload) {
  if (!payload || typeof payload !== "object") return [];

  /* Single item */
  if (!Array.isArray(payload) && payload.type && payload.name) return [payload];

  /* Top-level array */
  if (Array.isArray(payload)) {
    return payload.flatMap(entry => {
      if (Array.isArray(entry)) return entry; // nested arrays
      if (entry?.type && entry?.name) return [entry];
      /* Could be a container with items inside */
      if (entry?.items) return extractImportItems(entry);
      return [];
    });
  }

  /* Gather from known container keys */
  const ITEM_KEYS = ["items", "documents", "results", "entries", "inventory", "equipment", "gear", "loot"];
  const collected = [];
  for (const key of ITEM_KEYS) {
    const value = payload[key];
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (Array.isArray(entry)) {
          collected.push(...entry.filter(e => e?.type && e?.name));
        } else if (entry?.type && entry?.name) {
          collected.push(entry);
        } else if (entry?.item && entry.item?.type) {
          /* D&D Beyond style: { item: {...}, quantity: N } */
          const merged = { ...entry.item };
          if (entry.quantity) merged._importQuantity = Number(entry.quantity) || 1;
          collected.push(merged);
        } else if (typeof entry === "object" && entry !== null) {
          /* Try one level deeper */
          const deep = extractImportItems(entry);
          collected.push(...deep);
        }
      }
    }
  }

  /* D&D Beyond: { character: { inventory: [...] } } */
  if (payload.character?.inventory) {
    collected.push(...extractImportItems({ items: payload.character.inventory }));
  }

  return collected;
}

/**
 * Normalize a raw item object from any JSON source to something
 * that passes isImportableItem. Resolves type aliases and infers
 * missing fields where possible.
 * Returns null if the item is unrecoverable.
 */
function normalizeRawItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  /* Must have at least a name */
  const name = String(raw.name ?? raw.label ?? raw.title ?? "").trim();
  if (!name) return null;

  /* Resolve type */
  let type = String(raw.type ?? raw.itemType ?? raw.category ?? "").trim().toLowerCase();

  /* Check aliases */
  if (!SELLABLE_TYPES.has(type)) {
    type = TYPE_ALIASES[type] ?? TYPE_ALIASES[type.replace(/-/g, " ")] ?? type;
  }

  /* Last-resort inference from name / description */
  if (!SELLABLE_TYPES.has(type)) {
    type = inferTypeFromName(name, raw);
  }

  if (!SELLABLE_TYPES.has(type)) return null; /* Still unknown — skip */

  /* Rebuild a minimal Foundry-compatible object */
  const item = foundry.utils.deepClone(raw);
  item.name = name;
  item.type = type;
  item.img  ??= raw.img ?? raw.image ?? raw.icon ?? "icons/svg/item-bag.svg";

  /* Ensure system structure */
  item.system ??= {};

  /* Quantity override from D&D Beyond wrapper */
  if (raw._importQuantity) {
    item.system.quantity = raw._importQuantity;
    delete item._importQuantity;
  }

  /* Price: handle various common shapes */
  if (!item.system.price || (item.system.price.value == null && !item.system.price.denomination)) {
    item.system.price = inferPrice(raw);
  }

  /* Rarity: normalize casing and spacing */
  if (item.system.rarity) {
    item.system.rarity = normalizeRarity(item.system.rarity);
  }

  return item;
}

/**
 * Infer item type from its name when the type field is missing or unknown.
 */
function inferTypeFromName(name, raw) {
  const n = name.toLowerCase();
  const desc = String(raw.description ?? raw.system?.description?.value ?? "").toLowerCase();
  const combined = `${n} ${desc}`;

  if (/\b(sword|axe|bow|dagger|spear|mace|club|flail|hammer|lance|morningstar|pike|rapier|scimitar|shortsword|sickle|trident|warhammer|whip|crossbow|sling|dart|javelin|staff|wand|rod|gun|pistol|rifle|cannon)\b/.test(combined)) return "weapon";
  if (/\b(armor|armour|shield|breastplate|chainmail|leather armor|plate armor|scale mail|splint armor|ring mail|hide armor|padded armor|studded leather|helmet|gauntlets|boots|cloak|gloves)\b/.test(combined)) return "equipment";
  if (/\b(potion|scroll|elixir|tincture|arrow|bolt|bullet|pellet|blowgun needle|sling bullet|ammunition|ammo)\b/.test(combined)) return "consumable";
  if (/\b(kit|tools|set|artisan|instrument|navigator|thieves|disguise|forgery|herbalism|poisoner|gaming|vehicle)\b/.test(combined)) return "tool";
  if (/\b(bag|backpack|chest|barrel|basket|bedroll|blanket|bucket|case|chain|crowbar|flask|hourglass|lantern|lamp|map|oil|paper|pole|pot|pouch|quiver|rope|sack|scale|shovel|signal whistle|spellbook|spyglass|tent|torch|waterskin|whetstone|gem|art|trinket|gold|silver|treasure|trade)\b/.test(combined)) return "loot";

  return "";
}

/**
 * Try to extract a { value, denomination } price from a raw item.
 */
function inferPrice(raw) {
  /* Direct system.price */
  const sp = raw.system?.price;
  if (sp?.value != null) return { value: Number(sp.value) || 0, denomination: sp.denomination ?? "gp" };

  /* Flat price fields */
  const flat = raw.price ?? raw.cost ?? raw.value ?? raw.goldValue;
  if (flat != null) {
    if (typeof flat === "object") {
      return { value: Number(flat.value ?? flat.amount ?? 0) || 0, denomination: String(flat.denomination ?? flat.currency ?? "gp").toLowerCase() };
    }
    /* Parse strings like "5 gp", "10sp", "50 cp" */
    const match = String(flat).match(/^([\d.]+)\s*(pp|gp|ep|sp|cp)?$/i);
    if (match) return { value: Number(match[1]) || 0, denomination: (match[2] ?? "gp").toLowerCase() };
    return { value: Number(flat) || 0, denomination: "gp" };
  }

  return { value: 0, denomination: "gp" };
}

/**
 * Normalize rarity strings like "Very Rare", "veryRare", "very_rare" → "veryRare"
 */
function normalizeRarity(raw) {
  const map = {
    "common"     : "common",
    "uncommon"   : "uncommon",
    "rare"       : "rare",
    "very rare"  : "veryRare",
    "veryrare"   : "veryRare",
    "very_rare"  : "veryRare",
    "very-rare"  : "veryRare",
    "legendary"  : "legendary",
    "artifact"   : "artifact"
  };
  return map[String(raw).toLowerCase().trim()] ?? String(raw);
}

function isImportableItem(item) {
  return item?.name && item?.type && SELLABLE_TYPES.has(item.type);
}

function sanitizeImportedItem(item) {
  const data = foundry.utils.deepClone(item);
  delete data._id;
  delete data.folder;
  delete data.sort;
  data.effects ??= [];
  data.flags ??= {};
  data.system ??= {};
  data.system.quantity = Number(data.system.quantity ?? 1) || 1;
  data.system.price ??= { value: 0, denomination: "gp" };
  if (!data.system.price.denomination) data.system.price.denomination = "gp";
  return data;
}

/**
 * Deterministic item ID using a fast hash of (source + type + identifier/name).
 * Prevents duplicates when re-importing the same file from a different path.
 */
function importedItemId(source, itemData) {
  const key = itemData.system?.identifier ?? itemData.name;
  const raw = `${source}::${itemData.type}::${key}`;
  return `import.${slugify(raw)}`;
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function stockEntryId(entry) {
  return entry.uuid ?? entry.importId ?? importedItemId(entry.source ?? "import", entry.itemData ?? {});
}

function categorizeItem(itemData, categories) {
  const type    = itemData.type;
  const subtype = itemSubtype(itemData);
  const rarity  = normalizeRarity(itemData.system?.rarity ?? "");

  /* Ammunition: consumables with ammo subtype */
  if (type === "consumable" && subtype === "ammo" && categories.some(c => c.id === "ammunition")) {
    return "ammunition";
  }

  /* Magic items: any non-common rarity */
  const nonMagicRarities = new Set(["", "common"]);
  if (!nonMagicRarities.has(rarity) && categories.some(c => c.id === "magic")) {
    return "magic";
  }

  /* Potion / scroll → consumable category even if subtype differs */
  if (type === "consumable" && categories.some(c => c.id === "consumable")) {
    const name = String(itemData.name ?? "").toLowerCase();
    if (["potion","elixir","tincture"].some(k => name.includes(k))) {
      return "consumable";
    }
  }

  /* Standard type match */
  const match = categories.find(cat => cat.itemTypes?.includes(type) && cat.id !== "magic" && cat.id !== "ammunition");
  if (match) return match.id;

  /* Fallback: first category */
  return categories[0]?.id ?? "weapon";
}

function itemSubtype(itemData) {
  return (
    itemData.system?.consumableType
    ?? itemData.system?.type?.value
    ?? itemData.system?.type?.subtype
    ?? itemData.system?.weaponType
    ?? ""
  );
}

function rankFromItemData(itemData) {
  const rarity = normalizeRarity(itemData.system?.rarity ?? "");
  const ranks  = { common:"D", uncommon:"C", rare:"B", veryRare:"A", legendary:"S", artifact:"S" };
  return ranks[rarity] ?? "C";
}

function rankFromItem(item) {
  const rarity = normalizeRarity(item.system?.rarity ?? "");
  const ranks  = { common:"D", uncommon:"C", rare:"B", veryRare:"A", legendary:"S", artifact:"S" };
  return ranks[rarity] ?? "C";
}

function stripHtml(value = "") {
  return String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function ownedQuantity(actor, name) {
  if (!actor) return 0;
  return actor.items
    .filter(i => i.name === name)
    .reduce((sum, i) => sum + Number(i.system?.quantity ?? 1), 0);
}

function randomSku(value) {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash) + char.charCodeAt(0);
  return Math.abs(hash).toString(36).padStart(8, "0").slice(0, 8).toUpperCase();
}
