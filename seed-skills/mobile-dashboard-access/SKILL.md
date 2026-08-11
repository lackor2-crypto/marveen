---
name: mobile-dashboard-access
description: A Marveen dashboard biztonsagos telefonos elerese (PWA + token/eszközkulcs). WSL2-n Tailscale Serve az ajanlott ut. Trigger: "telefonrol/mobilrol elerjem Marveent", mobil dashboard, remote access setup.
---
# Mobil dashboard elerés (WSL2)

## Mikor használd
{{OWNER_NAME}} telefonrol/mobilrol akarja elerni a Marveen dashboardot (localhost:3420).

## Kontextus (felderites)
- A dashboard 127.0.0.1:3420-ra kot (WEB_HOST default 127.0.0.1). Telefonrol kozvetlenul NEM elerheto.
- Marveen beepitett: mobil PWA (app-ikon, token-beillesztő, mobil-nezet), password/session auth, es PER-ESZKOZ eszközkulcs (auth-device-keys.ts, prefix `mvdk_`, kulon revokalhato).
- Hivatalos doksi: `docs/mobil-dashboard.md`. Az AJANLOTT ut a Tailscale Serve (tailnet-only HTTPS proxy), NEM a nyers LAN.

## Eljárás (Tailscale, ajanlott)
1. Tailscale telepites WSL-ben (sudo -> {{OWNER_NAME}} futtatja): `curl -fsSL https://tailscale.com/install.sh | sh`
2. Belepes ({{OWNER_NAME}}, browser consent): `sudo tailscale up` -> a linket megnyitja, engedelyezi a fiokjaval.
3. Dashboard megosztasa a tailneten (ezt te is futtathatod): `tailscale serve --bg 3420`
4. URL: `tailscale serve status` -> `https://<gep>.<tailnet>.ts.net/`
5. Telefon: Tailscale app, UGYANAZ a fiok, bekapcsol. Bongesző: `https://<gep>.<tailnet>.ts.net/?token=<TOKEN>` -> "Fokepernyohoz adas" (PWA).
6. 2. lepes (kesobb): kulon device key a telefonra a megosztott token HELYETT (revokalhato). A dashboard auth/eszközkulcs feluleten mintheto.

## Buktatók
- Tailscale-t WSL-BEN futtasd (nem Windowson), kulonben a Windows localhostjat szolgalna ki, nem a WSL-beli dashboardot.
- A telepites sudo + a `tailscale up` {{OWNER_NAME}} fiokja -> ezek a tulajdonos ({{OWNER_NAME}}) lepesei (package_install + browser consent). Ne probald headless.
- LAN alternativa (azonos WiFi): WEB_HOST=0.0.0.0 + Windows `netsh interface portproxy` a WSL-IP-re + tuzfal-szabaly (admin). Torékeny: a WSL belso IP ujrainditaskor valtozik, csak HTTP, csak otthoni halo. Csak ha {{OWNER_NAME}} ezt keri.
- A tokent (`store/.dashboard-token`) SOSE ird chatbe. {{OWNER_NAME}} a gepen olvassa ki, vagy device key-t adunk.
- tailscaled tartos futasahoz a user linger mar be van kapcsolva (systemd user).

## Ellenőrzés
- `tailscale serve status` mutatja a HTTPS URL-t.
- Telefon bongeszőbol a token/eszközkulcs utan betolt a dashboard.
- A dashboard tovabbra is csak localhostra kot; a Tailscale csak proxyzza (nincs LAN/net kitettseg).
