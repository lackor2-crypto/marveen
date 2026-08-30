---
name: kanban-approval-workflow-fix
description: Approval gomb és PUT route hiányzó feldolgozása – összesen 3 OK javítása.
scope: global
---

# Kanban approval workflow fix

## Mikor használd

Amikor jóváhagyásra vágysz küldeni egy kártyát, és:
1. A dashboard gomb nem működik (POST /api/approvals 400-at ad)
2. Az error üzenet nem jelenik meg (általános toast)
3. Status PUT-tal módosítva nem hoz létre approval-t

## Eljárás

1. **OK 1** — `web/app.js` requestApprovalBtn.onclick: POST body-hoz `similar_reviewed: []` mező
2. **OK 2** — `web/app.js` requestApprovalBtn: error response JSON-ből szöveg, ne általános toast
3. **OK 3** — `src/web/routes/kanban.ts` PUT handler: ha `data.status === 'waiting'`, hívd `ensureApprovalForWaitingCard(id, data.actor)`

## Buktatók

- A `similar_reviewed` mező KÖTELEZŐ, vagy 400-at kapsz. Üreset ([]) lehet küldeni, ha nincs hasonló kártya.
- A szerver-hiba leírása magyar — SOHA nem szabad általános toast helyett küldenni, vagy {{OWNER_NAME}} nem látja a constraint-et.
- PUT route-ra az approval-check hiányzik, míg /move POST-on van. Szinkronizálni kell.

## Ellenőrzés

- Dashboard gomb: jóváhagyásra küldés működik
- Hibaüzenet: magyar szöveg jelenik meg, nem általános
- Drag-drop (waiting-re): approval automatikus
- PUT status-módosítás: approval automatikus
