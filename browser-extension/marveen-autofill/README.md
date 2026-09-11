# Marveen autofill

A tiny browser add-on that fills login forms from your Marveen Vault instead of
the browser's own password manager. It talks to one Marveen dashboard, over one
narrowly scoped credential, and it never receives a password for a site it is
not standing on.

This file is what you get when you unpack the zip, so it is written for the
person doing the unpacking, in both languages.

---

## Magyarul

### Mit csinál

Ha egy weboldal belépőjét elmentetted a Marveen Vaultba, ez a kiegészítő
kitölti vele a bejelentkező űrlapot. A jelszó nem megy át a vágólapon, és a
böngésző saját jelszókezelőjének sem kell tudnia róla.

### Telepítés (Chrome vagy Edge)

1. Csomagold ki ezt a mappát oda, ahol megmaradhat. A böngésző innen fogja
   betölteni: ha később törlöd vagy átmozgatod, a kiegészítő eltűnik.
2. Írd be a böngésző címsorába: `chrome://extensions` (Edge esetén
   `edge://extensions`).
3. Kapcsold be jobb fent a **Fejlesztői módot**.
4. Nyomd meg a **Kicsomagolt bővítmény betöltése** gombot, és válaszd ki ezt a
   mappát (azt, amelyikben ez a fájl van).
5. Kattints a kiegészítő ikonjára, és töltsd ki a három mezőt:
   - **Marveen címe**: a dashboard címe, például `http://localhost:3420`. A
     dashboard Fiókok lapja ki is írja, másolható gombbal.
   - **Párosítási kód**: a Fiókok lapon az „Új párosítási kód" gomb adja. Nyolc
     karakter, tíz percig él, és pontosan egy böngészőt párosít.
   - **A böngésző neve**: bármi, amiről felismered (pl. „Munkahelyi laptop").
     Ez a név látszik majd a dashboardon.
6. Nyomd meg a **Párosítás** gombot. Ha a Marveen nem a saját gépeden fut, a
   böngésző ilyenkor kér egy engedélyt arra a címre -- ez kell a működéshez.

### Használat

Nyiss meg egy bejelentkező oldalt. Ha pontosan egy elmentett kártya tartozik
hozzá, a kiegészítő magától kitölti (ez a viselkedés a kiegészítő ablakában
kikapcsolható). Ha több is van, egy kis listát kapsz, és te választasz.

### Hozzáférés visszavonása

A dashboard Fiókok lapján, a „Párosított böngészők" listában egy gombbal. A
visszavonás azonnali: a böngésző következő kérése már ismeretlen.

---

## English

### What it does

When you save a website login in the Marveen Vault, this add-on fills the login
form from it. The password never passes through the clipboard, and the browser's
own password manager never has to know about it.

### Install (Chrome or Edge)

1. Unpack this folder somewhere it can stay. The browser loads it from that
   path: delete or move it later and the add-on disappears.
2. Open `chrome://extensions` (or `edge://extensions`) in the address bar.
3. Turn on **Developer mode** in the top right.
4. Press **Load unpacked** and select this folder (the one holding this file).
5. Click the add-on icon and fill in the three fields:
   - **Marveen address**: your dashboard address, e.g. `http://localhost:3420`.
     The dashboard's Accounts page prints it with a copy button.
   - **Pairing code**: press "New pairing code" on the Accounts page. Eight
     characters, alive for ten minutes, pairs exactly one browser.
   - **Name this browser**: anything you will recognise ("Work laptop"). This is
     the name the dashboard shows.
6. Press **Pair**. If Marveen does not run on this machine, the browser will ask
   you to grant access to that address; it is required.

### Using it

Open a login page. If exactly one saved entry covers it, the add-on fills the
form (you can turn that off in the popup). If several do, it offers a small
picker and you choose.

### Revoking access

On the dashboard's Accounts page, in the "Paired browsers" list, one button.
Revocation is immediate: the browser's very next request is an unknown token.

---

## How it is kept safe

- **Its own credential.** Pairing mints an `mvaf_` token that belongs to this
  browser alone. It is not the dashboard token and not a device key, and the
  server stores only its SHA-256 hash.
- **Scoped to three endpoints.** The auth gate resolves that token *only* on
  `/api/autofill/pair`, `/lookup` and `/credential`. Presented anywhere else --
  memories, kanban, the vault itself -- it authenticates as nobody.
- **The page cannot say where it is.** The add-on never sends the address the
  page reports about itself. The service worker takes it from what Chrome says
  about the frame the message came from (`sender.url`), which no script on the
  page can rewrite.
- **The server decides the domain, not the page.** A stored entry for
  `youtube.com` covers `youtube.com` and its subdomains and nothing else:
  `youtube.com.evil.tld` and `evil-youtube.com` are refused. The check runs
  again when the password is actually handed over, not only when the list is
  built.
- **Lookups never carry passwords.** The list the popup shows contains labels
  and usernames. A password crosses the wire only in the single response to
  `/credential`, for one entry, for one page.
- **Everything is logged.** Every delivery and every refusal lands in the
  dashboard's "What happened" list, with the site and the entry, never the
  password.
