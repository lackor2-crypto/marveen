# =====================================================================
#  16 BITES FELVEVO  --  a waveIn API-ra epitve, ELO SZINTFIGYELESSEL
# =====================================================================
#  MIERT waveIn (2026-08-08, meressel):
#  Az MCI ezen a gepen NEM hajlando 16 bitre valtani: a 'set ... bitspersample
#  16' MINDEN sorrendben elutasitva (RC=282, ot sorrendet probaltunk vegig).
#  A 8 bites felvetel halk mikrofonnal hasznalhatatlan: 1-2%-os jelszintnel
#  mindossze 2-3 kihasznalt szint marad a 256-bol.
#
#  LEALLITAS (2026-08-08 esti visszajelzes, ket kor utan):
#  1. kapcsologomb (masodik inditas) -- NEM mukodik talcara tuzott ikonnal: a
#     Windows a mar futo peldanyra valt ahelyett hogy ujat inditana.
#  2. csend-figyeles -- ELVETVE: Boss diktalas kozben megall gondolkodni, es a
#     felvetel ido elott befejezodott volna.
#  3. VEGLEGES: barhol torteno EGERKATTINTAS allitja le. Ez egyben ki is jeloli,
#     hova kerul a szoveg -- a leallito kattintas es a beszurasi pont ugyanaz.
#     A leallitas logikaja a hivo felben van (diktal-auto.ps1), nem itt.
#
#  MUKODES: elore lefoglalunk N darab 1 masodperces puffert, mindet betoljuk a
#  driverhez, majd inditunk. A driver sorban tolti oket; a mar kesz pufferekbol
#  barmikor kiolvashato az aktualis hangero (RecentRms) -- ez mostmar csak
#  diagnosztika. Se callback, se szal, igy nem tud versenyhelyzetbe kerulni.
#
#  ***CSAK ASCII karakterek! (a PowerShell 5.1 ANSI-kent olvassa a .ps1-et)
# =====================================================================

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;

public class HuWaveRecorder {
  [StructLayout(LayoutKind.Sequential)]
  struct WAVEFORMATEX {
    public ushort wFormatTag, nChannels;
    public uint nSamplesPerSec, nAvgBytesPerSec;
    public ushort nBlockAlign, wBitsPerSample, cbSize;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct WAVEHDR {
    public IntPtr lpData; public uint dwBufferLength, dwBytesRecorded;
    public IntPtr dwUser; public uint dwFlags, dwLoops;
    public IntPtr lpNext, reserved;
  }

  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, int dev, ref WAVEFORMATEX f, IntPtr cb, IntPtr inst, int flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInStop(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInReset(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);

  const int WAVE_MAPPER = -1;      // a rendszer ALAPERTELMEZETT felveteli eszkoze
  const int RATE = 16000, BITS = 16, CH = 1;
  const int CHUNK_MS = 1000;
  const int BUFSZ = RATE * (BITS/8) * CH * CHUNK_MS / 1000;   // 32000 bajt = 1 mp
  const int NBUF = 300;                                        // 5 PERC felso hatar
  // 5 perc = 9.6 MB nyers PCM. A Groq atirasi vegpontja 25 MB-ig fogad, tehat
  // bven belefer; a memoria is rendben (300 puffer x 32 kB).
  const uint WHDR_DONE = 0x00000001;

  IntPtr h = IntPtr.Zero;
  List<IntPtr> hdrs = new List<IntPtr>();
  List<IntPtr> bufs = new List<IntPtr>();
  int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
  bool closed = false;

  public int LastError = 0;
  public static int ChunkMs { get { return CHUNK_MS; } }
  public static int MaxChunks { get { return NBUF; } }

  // ***2026-08-09: NEM A WAVE_MAPPER-RE BIZZUK TOBBE ***
  // A hiba: a diktalas "elnemult" (RMS 2.4% -> 0.4%), mikozben a modern MMDevice API
  // szerint MINDEN rendben volt: helyes eszkoz, +30 dB (a plafon), nincs nemitas.
  // Es KOZBEN ugyanaz a mikrofon MAS programban (Marveen) hibatlanul mukodott.
  // Az ok: a `WAVE_MAPPER` a REGI MME-reteg "preferalt eszkoze", ami NEM feltetlenul
  // azonos az MMDevice-alapertelmezettel. Ket bemenet van a gepen:
  //     [0] Microphone (... High Definition Audio ...)  = a FEJHALLGATOE
  //     [1] Mikrofon (Realtek USB2.0 MIC)               = a WEBKAMERAE
  // Ha a mapper a [1]-re mutat, a felvetel a szoba tuloldalarol jon -> pont ilyen halkan,
  // es a diagnosztika kozben tokeletes eszkozt jelez. Ezert mostantol NEV SZERINT,
  // EXPLICITEN nyitjuk meg az eszkozt, es a NEVET NAPLOZZUK is.
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct WAVEINCAPS {
    public short wMid; public short wPid; public int vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szPname;
    public int dwFormats; public short wChannels; public short wReserved1;
  }
  [DllImport("winmm.dll")] static extern int waveInGetNumDevs();
  [DllImport("winmm.dll", CharSet=CharSet.Unicode)]
  static extern int waveInGetDevCapsW(IntPtr id, ref WAVEINCAPS c, int size);

  public string OpenedDeviceName = "(ismeretlen)";

  public static string DeviceName(int i) {
    var c = new WAVEINCAPS();
    if (i < 0) return "WAVE_MAPPER (rendszer-alapertelmezett)";
    if (waveInGetDevCapsW((IntPtr)i, ref c, Marshal.SizeOf(c)) != 0) return "(nem olvashato)";
    return c.szPname;
  }

  public static string ListDevices() {
    var sb = new StringBuilder();
    int n = waveInGetNumDevs();
    for (int i = 0; i < n; i++) sb.Append("[" + i + "] " + DeviceName(i) + "  ");
    return sb.ToString();
  }

  /// A `match`-et TARTALMAZO nevu eszkoz indexe; -1 ha nincs ilyen (akkor a hivo dont).
  public static int FindDevice(string match) {
    if (string.IsNullOrEmpty(match)) return -1;
    int n = waveInGetNumDevs();
    for (int i = 0; i < n; i++) {
      string nm = DeviceName(i);
      if (nm != null && nm.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) return i;
    }
    return -1;
  }

  public bool Start() { return Start(-1); }

  public bool Start(int dev) {
    WAVEFORMATEX f = new WAVEFORMATEX();
    f.wFormatTag = 1; f.nChannels = (ushort)CH; f.nSamplesPerSec = RATE;
    f.wBitsPerSample = (ushort)BITS; f.nBlockAlign = (ushort)(CH * BITS / 8);
    f.nAvgBytesPerSec = (uint)(RATE * f.nBlockAlign); f.cbSize = 0;

    LastError = waveInOpen(out h, dev, ref f, IntPtr.Zero, IntPtr.Zero, 0);
    if (LastError != 0) return false;
    OpenedDeviceName = DeviceName(dev);

    for (int i = 0; i < NBUF; i++) {
      IntPtr buf = Marshal.AllocHGlobal(BUFSZ);
      WAVEHDR hd = new WAVEHDR();
      hd.lpData = buf; hd.dwBufferLength = (uint)BUFSZ;
      IntPtr ph = Marshal.AllocHGlobal(hdrSize);
      Marshal.StructureToPtr(hd, ph, false);
      if (waveInPrepareHeader(h, ph, hdrSize) != 0) { LastError = -1; return false; }
      if (waveInAddBuffer(h, ph, hdrSize) != 0)     { LastError = -2; return false; }
      hdrs.Add(ph); bufs.Add(buf);
    }
    LastError = waveInStart(h);
    return LastError == 0;
  }

  /// Hany negyed-masodperces szelet keszult el eddig. A driver SORBAN tolti a
  /// puffereket, ezert az elso nem-kesz szeletnel meg lehet allni.
  public int CompletedChunks() {
    if (closed) return 0;
    int n = 0;
    for (int i = 0; i < hdrs.Count; i++) {
      WAVEHDR hd = (WAVEHDR)Marshal.PtrToStructure(hdrs[i], typeof(WAVEHDR));
      if ((hd.dwFlags & WHDR_DONE) != 0 && hd.dwBytesRecorded > 0) n++;
      else break;
    }
    return n;
  }

  /// Az UTOLSO 'chunks' darab elkeszult szelet RMS-e, 0..1 skalan (1 = teljes
  /// kivezerles). Ebbol dont a hivo fel arrol, hogy beszed megy-e vagy csend.
  public double RecentRms(int chunks) {
    int done = CompletedChunks();
    if (done <= 0) return 0.0;
    int start = done - chunks; if (start < 0) start = 0;
    double sum = 0; long cnt = 0;
    for (int i = start; i < done; i++) {
      WAVEHDR hd = (WAVEHDR)Marshal.PtrToStructure(hdrs[i], typeof(WAVEHDR));
      int n = (int)hd.dwBytesRecorded;
      if (n <= 1) continue;
      byte[] tmp = new byte[n];
      Marshal.Copy(hd.lpData, tmp, 0, n);
      for (int k = 0; k + 1 < n; k += 2) {
        short s = BitConverter.ToInt16(tmp, k);
        sum += (double)s * s; cnt++;
      }
    }
    return cnt > 0 ? Math.Sqrt(sum / cnt) / 32768.0 : 0.0;
  }

  /// Leallit, es kiirja a WAV-ot. Visszaadja a felvett mintak szamat.
  public int StopAndSave(string path) {
    if (closed) return 0;
    closed = true;
    waveInStop(h);
    waveInReset(h);   // a fel-teli puffereket is visszaadja, dwBytesRecorded-del
    MemoryStream pcm = new MemoryStream();
    for (int i = 0; i < hdrs.Count; i++) {
      WAVEHDR hd = (WAVEHDR)Marshal.PtrToStructure(hdrs[i], typeof(WAVEHDR));
      int n = (int)hd.dwBytesRecorded;
      if (n > 0) { byte[] tmp = new byte[n]; Marshal.Copy(hd.lpData, tmp, 0, n); pcm.Write(tmp, 0, n); }
      waveInUnprepareHeader(h, hdrs[i], hdrSize);
      Marshal.FreeHGlobal(hdrs[i]); Marshal.FreeHGlobal(bufs[i]);
    }
    hdrs.Clear(); bufs.Clear();
    waveInClose(h); h = IntPtr.Zero;

    byte[] data = pcm.ToArray();
    int blockAlign = CH * BITS / 8;
    using (BinaryWriter w = new BinaryWriter(File.Create(path))) {
      w.Write(new char[]{'R','I','F','F'}); w.Write(36 + data.Length);
      w.Write(new char[]{'W','A','V','E'});
      w.Write(new char[]{'f','m','t',' '}); w.Write(16);
      w.Write((short)1); w.Write((short)CH); w.Write(RATE);
      w.Write(RATE * blockAlign); w.Write((short)blockAlign); w.Write((short)BITS);
      w.Write(new char[]{'d','a','t','a'}); w.Write(data.Length);
      w.Write(data);
    }
    return data.Length / blockAlign;
  }
}
'@
