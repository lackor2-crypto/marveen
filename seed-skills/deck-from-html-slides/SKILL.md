---
name: deck-from-html-slides
scope: global
description: Build a colorful presentation as a Workbench deck from HTML slides (Playwright to PNG/PDF, then image objects on deck slides). Use when asked for a visual plan deck without extending the deck editor.
---
# Deck from HTML slides

## Mikor használd
Színes terv-/bemutató-prezentáció kell Prezentáció munkadarabként, és a deck-szerkesztő (csak szöveg/téglalap/kép) nem elég.

## Eljárás
1. Dia = `<section class="slide">` 1280x720, közös stíluslap; scratchpadben dolgozz, ne a repóban.
2. Playwright, `deviceScaleFactor:1.5` -> 1920x1080 PNG elemenként + `page.pdf` (width/height 1280x720px).
3. PNG-k és PDF a Raktár projektmappájába (`<Projekt>/Munkadarabok/<név>/diak/sNN.png`).
4. Meglévő deck: a régi diák képeit felülírja a másolás (azonos fájlnév). Új dia: `POST /api/workbench/items/<id>/deck/ops` `{"ops":[{"op":"addSlide"}]}`, majd `{"op":"slide","id":"dN","ops":[{"op":"add","type":"image","src":"<depó-relatív>","x":0,"y":0,"width":1920,"height":1080,"fit":"cover"}]}`.

## Buktatók
- Az `addSlide` üres `title` és `body` szövegmezőt is tesz: töröld (`{"op":"remove","id":"title"}`, `body`), különben a kép fölé/alá kerül.
- Playwright alapból 1280x720 PNG-t ad; a deck vászna 1920x1080.
- Átfedő callout-ok: renderelés után nézd meg a képet.

## Ellenőrzés
- `GET .../deck`: diánként 1 objektum, a diaszám egyezik a PNG-kkel.
