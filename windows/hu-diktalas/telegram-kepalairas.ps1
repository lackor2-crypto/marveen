# =====================================================================
#  TELEGRAM: A DIKTALAS NE KEPALAIRASBA MENJEN, HANEM SIMA UZENETBE  (#503)
# =====================================================================
#  A HIBA (Boss TG 2675 / 2680): Boss egy kepernyokepet illeszt be a
#  Telegramba, es a felnyilo kep-kuldo ablak KEPALAIRAS-mezojebe diktal,
#  tobbszor egymas utan. A Telegram Desktop ezt a mezot 1024 karakterre
#  korlatozza (Premiummal tobb) -- a forrasban send_files_box.cpp:
#      _caption->setMaxLength(Data::PremiumLimits(...).captionLengthCurrent());
#  Ami a hataron tul van, azt a mezo a beillesztesnel CSENDBEN eldobja: nincs
#  hibauzenet, nincs masodik uzenet (merve: 1254 karakterbol 1024 erkezett).
#  Olyan Telegram-beallitas, ami a hosszu kepalairast kulon uzenetbe tenne,
#  NINCS (kutatva 2026-10-07). A bevett megoldas: a kep megy kulon, a szoveg
#  SIMA UZENETKENT -- annak hatara 4096, a hosszabbat a Telegram Desktop maga
#  bontja tobb uzenetre.
#
#  MIT CSINAL: ha a diktalt szoveg a kep-kuldo ablak kepalairasaba menne,
#    1. kiolvassa, ami MAR a kepalairasban van, es kiuriti a mezot;
#    2. Enterrel elkuldi a kepet (szoveg nelkul);
#    3. a TELJES szoveget (a regi kepalairas + az uj diktalas) a sima
#       uzenetmezobe illeszti. Elkuldeni te kuldod, ahogy eddig: Enterrel.
#  A tovabbi diktalasok mar maguktol a sima uzenetmezobe mennek.
#
#  HONNAN TUDJA, HOGY KEPALAIRAS: Windows UI Automation. A Telegram Desktop a
#  fokuszban levo mezot es a szulo-elemeit OSZTALYNEVVEL adja -- ez nem fugg a
#  Telegram nyelvetol:
#    sima uzenetmezo:  class Ui::InputField::Inner -> class Ui::InputField
#                      -> class HistoryWidget          (merve 2026-10-07, 7.2.9)
#    kepalairas:       ... Ui::InputField -> SendFilesBox  (a forrasban a mezo
#                      szuloje a SendFilesBox: `_caption(this, ...)`)
#  Ha nem biztos (nincs UI Automation, ismeretlen mezo, nem olvashato a szoveg),
#  NEM nyul semmihez: marad a regi ut (beillesztes + figyelmeztetes).
#
#  Kikapcsolas: HU_DIKTALAS_KEPALAIRAS=marad kornyezeti valtozo.
#  ***CSAK ASCII karakterek! (a PowerShell 5.1 ANSI-kent olvassa a .ps1-et)
# =====================================================================

# A naploba ez a sor kerul, ha a szoveg a kepalairas helyett sima uzenetbe
# ment. A Marveen oldalan a telegram_caption_limit.py hook erre a sorra figyel:
# igy tudja az agens, hogy a szoveg nelkuli kep utan a szoveg kulon jon.
$TgMovedLogPrefix = 'kepalairas -> sima uzenet:'

# Melyik mezoben all a kurzor? $Classes: a fokuszban levo elem osztalyneve,
# utana a szuloje, felfele. 'caption' | 'message' | 'other'.
function Get-TgFieldKind {
  param([string[]]$Classes)
  $list = @($Classes | ForEach-Object { [string]$_ })
  if ($list.Count -eq 0 -or $list[0] -notmatch 'InputField') { return 'other' }
  foreach ($c in $list) { if ($c -match '\bSendFilesBox\b') { return 'caption' } }
  foreach ($c in $list) { if ($c -match '\bHistoryWidget\b') { return 'message' } }
  return 'other'
}

# A kepalairasban mar ott levo szoveg es az uj diktalas, egy szokozzel.
function Join-TgText {
  param([string]$Existing, [string]$New)
  $a = ([string]$Existing).Trim()
  $b = ([string]$New).Trim()
  if (-not $a) { return $b }
  if (-not $b) { return $a }
  return $a + ' ' + $b
}

function Wait-TgFocusLeaves {
  # Var, amig a fokusz el nem hagyja a kepalairast (= a kep-kuldo ablak bezarult).
  param([hashtable]$Io, [int]$WaitMs, [int]$StepMs)
  $waited = 0
  while ($true) {
    $f = & $Io.Focus
    if (-not $f -or $f.Kind -ne 'caption') { return $f }
    if ($waited -ge $WaitMs) { return $f }
    & $Io.Sleep $StepMs
    $waited += $StepMs
  }
}

function Clear-TgCaption {
  # Kijeloli es torli a kepalairas tartalmat; $true, ha utana tenyleg ures.
  param([hashtable]$Io)
  & $Io.Keys '^a'
  & $Io.Keys '{DEL}'
  $f = & $Io.Focus
  return ($f -and $f.Kind -eq 'caption' -and $null -ne $f.Text -and ([string]$f.Text).Trim() -eq '')
}

# A diktalt szoveget a kepalairas helyett sima uzenetbe teszi.
# $Io: a kulvilag (a tesztben hamisitva):
#   Focus        -> @{ Kind = 'caption'|'message'|'other'; Text = <a mezo szovege vagy $null> }
#   Keys  $k     -> billentyuk (SendKeys jeloles: '^a', '{DEL}', '{ENTER}', '^{ENTER}')
#   Paste $t     -> a szoveget a kurzorhoz illeszti
#   Sleep $ms
#   FocusMessage -> (nem kotelezo) a sima uzenetmezobe teszi a fokuszt; $true/$false
#   Log $m       -> (nem kotelezo) naplosor. A kep elkuldese ELOTT ir: a Marveen
#                   hookja a szoveg nelkul erkezo kepnel ezt a sort keresi, es a
#                   kep gyorsabban erhet oda, mint egy utana irt sor.
# Eredmeny: @{ Done; Touched; Reason; Clipboard; Text; Moved }
#   Done=$true    : a kep elment, a teljes szoveg a sima uzenetmezoben van.
#   Touched=$false: semmihez nem nyult -- a hivo a regi utat jarja.
#   Touched=$true es Done=$false: valami nem sikerult; a hivo a Clipboard
#                   szoveget a vagolapra teszi es figyelmeztet. Szoveg nem vesz el.
function Move-TgCaptionToMessage {
  param([string]$Text, [hashtable]$Io, [int]$WaitMs = 3000, [int]$StepMs = 100)
  $f = & $Io.Focus
  if (-not $f -or $f.Kind -ne 'caption') {
    return @{ Done = $false; Touched = $false; Reason = 'nem-kepalairas' }
  }
  if ($null -eq $f.Text) {
    # Nem tudjuk, mi van a kepalairasban -- akkor nem is uritjuk ki.
    return @{ Done = $false; Touched = $false; Reason = 'kepalairas-nem-olvashato' }
  }
  $old  = [string]$f.Text
  $full = Join-TgText $old $Text

  # 1. A kepalairas kiuritese: a kep szoveg nelkul menjen.
  if ($old.Trim() -ne '') {
    if (-not (Clear-TgCaption $Io)) {
      return @{ Done = $false; Touched = $true; Reason = 'kepalairas-nem-urult'; Clipboard = $full; Text = $full }
    }
  }

  # 2. A kep elkuldese. Enter: ez az alapbeallitas. Ha a Telegramban a
  #    "Ctrl+Enter kuld" van beallitva, az Enter csak egy uj sort ir a (most ures)
  #    kepalairasba -- ilyenkor kiuritjuk es Ctrl+Enterrel probaljuk.
  if ($Io.ContainsKey('Log') -and $Io.Log) {
    & $Io.Log "$TgMovedLogPrefix a kepet szoveg nelkul kuldom, a szoveg ($($full.Length) karakter) kulon, sima uzenetbe megy"
  }
  & $Io.Keys '{ENTER}'
  $after = Wait-TgFocusLeaves $Io $WaitMs $StepMs
  if ($after -and $after.Kind -eq 'caption') {
    [void](Clear-TgCaption $Io)
    & $Io.Keys '^{ENTER}'
    $after = Wait-TgFocusLeaves $Io $WaitMs $StepMs
  }
  if ($after -and $after.Kind -eq 'caption') {
    # A kep nem ment el: visszaallitjuk a kepalairast, ahogy volt (az belefert),
    # az uj diktalas a vagolapra kerul.
    [void](Clear-TgCaption $Io)
    if ($old.Trim() -ne '') { & $Io.Paste $old }
    $back = & $Io.Focus
    $restored = ($back -and $back.Kind -eq 'caption' -and ([string]$back.Text).Trim() -eq $old.Trim())
    $clip = $(if ($restored) { $Text } else { $full })
    return @{ Done = $false; Touched = $true; Reason = 'kep-nem-ment-el'; Clipboard = $clip; Text = $full }
  }

  # 3. A kep elment; a szoveg a sima uzenetmezobe.
  if (-not $after -or $after.Kind -ne 'message') {
    if ($Io.ContainsKey('FocusMessage') -and $Io.FocusMessage) {
      [void](& $Io.FocusMessage)
      $after = & $Io.Focus
    }
  }
  if (-not $after -or $after.Kind -ne 'message') {
    return @{ Done = $false; Touched = $true; Reason = 'uzenetmezo-nem-fokuszban'; Clipboard = $full; Text = $full }
  }
  & $Io.Paste $full
  return @{ Done = $true; Touched = $true; Reason = 'ok'; Text = $full; Moved = $old.Trim().Length }
}

# Mit mondjon a buborek, ha a szoveget nem sikerult atrakni.
function Get-TgMoveWarning {
  param([string]$Reason)
  switch ($Reason) {
    'uzenetmezo-nem-fokuszban' { return 'A kep elment. A szoveg a vagolapon van: kattints az uzenetmezobe, es Ctrl+V.' }
    'kep-nem-ment-el'          { return 'A kepet nem tudtam elkuldeni, a kepalairas maradt. Az uj szoveg a vagolapon: kuldd el a kepet, aztan Ctrl+V az uzenetmezobe.' }
    default                    { return 'A szoveg a vagolapon van (a korabbi kepalairassal egyutt): kuldd el a kepet, aztan Ctrl+V az uzenetmezobe.' }
  }
}

# ---------------------------------------------------------------------
#  A valodi kulvilag: Windows UI Automation + billentyuk + vagolap.
#  Csak Windowson hivhato; a teszt a fenti fuggvenyeket hamis $Io-val futtatja.
# ---------------------------------------------------------------------
function Get-TgFocus {
  $none = @{ Kind = 'other'; Text = $null; Classes = @() }
  try {
    $f = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $f) { return $none }
    $proc = Get-Process -Id $f.Current.ProcessId -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -ne 'Telegram') { return $none }
    $classes = New-Object System.Collections.ArrayList
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $e = $f; $i = 0
    while ($e -and $i -lt 12) {
      [void]$classes.Add([string]$e.Current.ClassName)
      $e = $walker.GetParent($e); $i++
    }
    $text = $null
    try { $text = [string]$f.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
    return @{ Kind = (Get-TgFieldKind -Classes $classes); Text = $text; Classes = @($classes) }
  } catch {
    return $none
  }
}

function Set-TgMessageFocus {
  # A Telegram-ablakban megkeresi a sima uzenetmezot (InputField a HistoryWidget
  # alatt), es odateszi a fokuszt. Merve: ~250 elem, ~0.4 mp.
  try {
    $p = Get-Process Telegram -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { return $false }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($root); $seen = 0
    while ($queue.Count -gt 0 -and $seen -lt 3000) {
      $e = $queue.Dequeue(); $seen++
      if ([string]$e.Current.ClassName -match 'InputField::Inner') {
        $classes = New-Object System.Collections.ArrayList
        $x = $e; $i = 0
        while ($x -and $i -lt 12) { [void]$classes.Add([string]$x.Current.ClassName); $x = $walker.GetParent($x); $i++ }
        if ((Get-TgFieldKind -Classes $classes) -eq 'message') { $e.SetFocus(); Start-Sleep -Milliseconds 150; return $true }
      }
      $c = $walker.GetFirstChild($e)
      while ($c) { $queue.Enqueue($c); $c = $walker.GetNextSibling($c) }
    }
  } catch { }
  return $false
}

function New-TgUiaIo {
  param([scriptblock]$Log = $null)
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
  return @{
    Log          = $Log
    Focus        = { Get-TgFocus }
    Keys         = { param($k) [System.Windows.Forms.SendKeys]::SendWait($k) }
    Paste        = { param($t) Set-Clipboard -Value $t; Start-Sleep -Milliseconds 120; [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 150 }
    Sleep        = { param($ms) Start-Sleep -Milliseconds $ms }
    FocusMessage = { Set-TgMessageFocus }
  }
}
