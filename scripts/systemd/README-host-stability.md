# Host stability: WSL-VM restart detection + crash-loop throttle

Root cause of the 2026-07-07 fleet-wide silence: the whole **WSL2 utility VM**
shut down (19:18:14 CEST) and re-booted (19:23:57 CEST) -- `journalctl
--list-boots` shows boot `-1` ending and boot `0` starting with a fresh kernel.
That tears down the kernel, system + user systemd, tmux, dashboard and channels
at once. It is **not** an application crash, and `Linger=yes` does not protect
against it (linger only survives session logout, not a VM teardown).

Under WSL2 a VM teardown is triggered from the **Windows side**, never from
inside the VM: `vmIdleTimeout` auto-shutdown (VM stops shortly after the last
WSL handle/terminal closes), Windows sleep/hibernate -> resume, `wsl
--shutdown`, a Windows/WSL update, or VM OOM.

## Pieces installed here

| File | Role |
|------|------|
| `host-restart-watchdog.sh` + `marveen-host-watchdog.service` | oneshot at every user-manager start; if `/proc/stat btime` changed vs `store/.last-btime`, Telegrams "host/WSL VM restarted" with an estimated downtime. btime-change => host restart. |
| `unit-fail-notify.sh` + `marveen-notify@.service` | instantiated by `OnFailure=marveen-notify@%n.service` drop-ins on the dashboard/channels units; Telegrams "app-crash: <unit> FAILED". OnFailure => app crash. |
| `marveen-channels.service` StartLimit fix | `StartLimitIntervalSec`/`StartLimitBurst` moved from `[Service]` (where systemd logged "Unknown key ... in section [Service]" and ignored them) to `[Unit]`, so the crash-loop throttle actually applies. |

The two notifiers deliberately use different triggers so a fleet-wide silence
can be classified: **btime change = host/VM restart**, **OnFailure = app crash**.

## Windows-side fix (do NOT automate from Linux)

To stop the VM from auto-shutting-down when idle, edit on the Windows host:

    %UserProfile%\.wslconfig

    [wsl2]
    vmIdleTimeout=-1

Then `wsl --shutdown` once from Windows for it to take effect. This is a Windows
filesystem change under `/mnt/c` and must be made by the user on Windows -- the
Linux side must not write it automatically.

## Also in this directory: the keepalive probe MUST be installed

`channel-keepalive-probe.{service,timer}` is not optional. The keepalive
freshness signal (`store/.channel-keepalive`) has two producers: organic inbound
traffic, and this idle-path probe. With only the first one, a **healthy but
quiet** channels session ages past `channel-watchdog`'s staleness threshold and
gets respawn-paned every ~30 minutes -- each needless respawn re-opens/wedges
the `/mcp` menu. Measured on 2026-08-14: the unit pair existed in the repo but
was never installed here, and the journal shows exactly that false respawn.

    cp scripts/systemd/channel-keepalive-probe.{service,timer} ~/.config/systemd/user/
    # substitute the install dir / user / unit prefix, then:
    systemctl --user daemon-reload
    systemctl --user enable --now <prefix>-channel-keepalive-probe.timer

`scripts/doctor.sh` now warns when this timer is missing, so the silent case is
visible instead of showing up only as an unexplained "keepalive stale".

## Rollback

    systemctl --user disable --now marveen-host-watchdog.service
    rm ~/.config/systemd/user/marveen-host-watchdog.service
    rm -rf ~/.config/systemd/user/marveen-dashboard.service.d/onfailure.conf \
           ~/.config/systemd/user/marveen-channels.service.d/onfailure.conf
    rm ~/.config/systemd/user/marveen-notify@.service
    # revert the channels StartLimit move by reinstalling the previous unit, then:
    systemctl --user daemon-reload
