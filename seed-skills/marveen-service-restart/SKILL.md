---
name: marveen-service-restart
description: A Marveen dashboard (vagy barmely {{MAIN_AGENT_ID}}-* szolgaltatas) ujrainditasa build/deploy utan. Hasznald MINDIG, amikor a dist/ ujraepult es eletbe kell leptetni. TILOS kezzel kill + nohup node dist/index.js -- az systemd-n KIVUL futo peldanyt csinal, amit semmi nem hoz vissza.
---
# Marveen szolgaltatas ujrainditas

## Mikor hasznald

- `npm run build` utan, hogy az uj kod eletbe lepjen.
- Barmikor, amikor a dashboard/channels ujrainditasa kell.

## A szabaly

```bash
systemctl --user restart {{MAIN_AGENT_ID}}-dashboard.service
systemctl --user status  {{MAIN_AGENT_ID}}-dashboard.service --no-pager | head -5
```

Szolgaltatasok: `{{MAIN_AGENT_ID}}-dashboard`, `{{MAIN_AGENT_ID}}-channels`,
`{{MAIN_AGENT_ID}}-cred-watch`. Listazas: `systemctl --user list-units --type=service | grep {{MAIN_AGENT_ID}}`

## TILOS (valos incidens, 2026-08-11)

```bash
kill $(cat store/dashboard.pid); nohup node dist/index.js &   # NE
```

Miert: a `kill` megoli a systemd altal kezelt peldanyt. A SIGTERM
"tiszta kilepes", tehat a `Restart=on-failure` policy NEM inditja ujra --
a systemd ugy veszi, szandekosan leallitottak. A helyere inditott
nohup-os peldany a systemd-n KIVUL fut, tehat amikor az meghal,
SEMMI nem hozza vissza.

**Kovetkezmeny elesben:** a dashboard 00:02-kor igy allt le, es 11:54-ig
(11.5 ora) allt, amig {{OWNER_NAME}} kezzel el nem inditotta. Ha nem lett volna
itthon, napokig allt volna. Az egesz flotta nema: nincs kanban-dispatch,
nincs utemezett feladat, nincs inter-agent uzenet.

## Ami azota vedi (de nem menti fel a fenti szabalyt)

- `Restart=always` drop-in:
  `~/.config/systemd/user/{{MAIN_AGENT_ID}}-dashboard.service.d/restart-always.conf`
- `{{MAIN_AGENT_ID}}-dashboard-health.timer` -- percenkent HTTP-proba, 3 sikertelen
  utan `systemctl --user restart`. Script: `scripts/dashboard-health-guard.sh`,
  naplo: `store/dashboard-health-guard.log`.

## Ellenorzes

```bash
systemctl --user show {{MAIN_AGENT_ID}}-dashboard.service -p MainPID -p Restart
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:{{WEB_PORT}}/
```
Az uj MainPID + HTTP valasz egyutt bizonyitja a sikeres ujrainditast.
Az exit-kod onmagaban nem: a szolgaltatas elindulhat es azonnal el is
halhat.
