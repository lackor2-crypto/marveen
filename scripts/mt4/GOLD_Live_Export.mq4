//+------------------------------------------------------------------+
//|  GOLD_Live_Export.mq4                                            |
//|                                                                  |
//|  Writes a fresh price + OHLC snapshot to MQL4/Files/gold_live.txt |
//|  so that scripts/gold-data.py can read second-fresh data even     |
//|  while MT4 sits minimised in the tray.                            |
//|                                                                  |
//|  WHY THIS EXISTS (kanban 70efa568 / #93):                         |
//|  Reading the .hst history files (kanban bd02805a) removed the     |
//|  screenshot/focus collision, but NOT the staleness: MT4 flushes    |
//|  .hst on its own slow schedule -- measured 167 minutes old data    |
//|  next to a live chart. An EA runs inside the terminal, so it sees  |
//|  the forming (shift=0) bar and the current Bid/Ask directly.       |
//|                                                                  |
//|  FILE FORMAT -- must stay in sync with read_live() in             |
//|  scripts/gold-data.py:                                            |
//|    META <symbol> <utc_epoch> <YYYY.MM.DD> <HH:MM:SS> <bid> <ask> <digits>
//|    TF <NAME> <minutes> <count>                                    |
//|    B <NAME> <bar_time> <open> <high> <low> <close> <volume>       |
//|    END <total_B_lines>                                            |
//|  The reader counts the B lines and compares them to END. If they   |
//|  differ the file was caught mid-write and the reader falls back to |
//|  .hst -- that is the intended torn-read guard, so a plain          |
//|  rewrite here is safe.                                            |
//|                                                                  |
//|  TIME CONVENTIONS (easy to get wrong):                            |
//|   - the META timestamp is TimeGMT(), i.e. a real UTC epoch,        |
//|     because the reader compares it against Python's time.time().   |
//|   - bar times are raw server time (Time[]), exactly what the .hst  |
//|     fallback contains, so live and hst readings stay comparable.   |
//+------------------------------------------------------------------+
#property copyright "Marveen"
#property link      "https://github.com/lackor2-crypto/marveen"
#property version   "1.00"
#property strict

input string ExportSymbol   = "";            // Symbol to export (empty = this chart)
input string OutFileName    = "gold_live.txt";
input int    RefreshSeconds = 30;            // How often to rewrite the file
input int    BarsPerTF      = 400;           // Bars per timeframe (MA100 needs >=100)

// The four timeframes scripts/gold-data.py asks for.
int    tfPeriods[4] = {PERIOD_D1, PERIOD_H1, PERIOD_M15, PERIOD_M5};
string tfNames[4]   = {"D1", "H1", "M15", "M5"};

string gSymbol   = "";
int    gWrites   = 0;
int    gFailures = 0;
string gLastError = "";

//+------------------------------------------------------------------+
int OnInit()
  {
   gSymbol = ExportSymbol;
   if(StringLen(gSymbol) == 0)
      gSymbol = Symbol();

   if(RefreshSeconds < 1)
     {
      Print("GOLD_Live_Export: RefreshSeconds must be at least 1.");
      return(INIT_PARAMETERS_INCORRECT);
     }
   if(BarsPerTF < 30)
     {
      // The reader ignores a live timeframe with fewer than 30 bars, so
      // exporting less than that would silently do nothing.
      Print("GOLD_Live_Export: BarsPerTF must be at least 30.");
      return(INIT_PARAMETERS_INCORRECT);
     }

   EventSetTimer(RefreshSeconds);
   WriteSnapshot();       // do not make the first reader wait a whole cycle
   ShowStatus();
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   Comment("");
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   WriteSnapshot();
   ShowStatus();
  }

//+------------------------------------------------------------------+
//| Writes the whole snapshot in one pass.                           |
//+------------------------------------------------------------------+
void WriteSnapshot()
  {
   int digits = (int)MarketInfo(gSymbol, MODE_DIGITS);
   if(digits <= 0)
      digits = Digits;
   double bid = MarketInfo(gSymbol, MODE_BID);
   double ask = MarketInfo(gSymbol, MODE_ASK);

   // A symbol that is not in Market Watch returns 0 here. Writing a 0 price
   // would look like a valid snapshot to the reader, so refuse instead.
   if(bid <= 0.0 || ask <= 0.0)
     {
      gFailures++;
      gLastError = "no quote for " + gSymbol + " (add it to Market Watch)";
      return;
     }

   int h = FileOpen(OutFileName, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
     {
      gFailures++;
      gLastError = "FileOpen failed, error " + IntegerToString(GetLastError());
      return;
     }

   datetime nowUtc = TimeGMT();
   FileWrite(h, "META " + gSymbol
             + " " + IntegerToString((int)nowUtc)
             + " " + TimeToStr(nowUtc, TIME_DATE | TIME_SECONDS)
             + " " + DoubleToStr(bid, digits)
             + " " + DoubleToStr(ask, digits)
             + " " + IntegerToString(digits));

   int written = 0;
   for(int t = 0; t < ArraySize(tfPeriods); t++)
     {
      int period    = tfPeriods[t];
      string name   = tfNames[t];
      int available = iBars(gSymbol, period);
      int take      = MathMin(BarsPerTF, available);

      FileWrite(h, "TF " + name
                + " " + IntegerToString(period)
                + " " + IntegerToString(take));

      // Oldest first, so the reader's indicator maths sees them in order.
      // shift 0 is the forming bar -- that is the whole point of this EA.
      for(int i = take - 1; i >= 0; i--)
        {
         FileWrite(h, "B " + name
                   + " " + IntegerToString((int)iTime(gSymbol, period, i))
                   + " " + DoubleToStr(iOpen(gSymbol, period, i), digits)
                   + " " + DoubleToStr(iHigh(gSymbol, period, i), digits)
                   + " " + DoubleToStr(iLow(gSymbol, period, i), digits)
                   + " " + DoubleToStr(iClose(gSymbol, period, i), digits)
                   + " " + IntegerToString((int)iVolume(gSymbol, period, i)));
         written++;
        }
     }

   FileWrite(h, "END " + IntegerToString(written));
   FileClose(h);

   gWrites++;
   gLastError = "";
  }

//+------------------------------------------------------------------+
//| On-chart status, so the user can see it works without opening     |
//| a log file. Bilingual, like every other user-facing Marveen text. |
//+------------------------------------------------------------------+
void ShowStatus()
  {
   string state_hu, state_en;
   if(StringLen(gLastError) > 0)
     {
      state_hu = "HIBA: " + gLastError;
      state_en = "ERROR: " + gLastError;
     }
   else if(gWrites == 0)
     {
      state_hu = "meg nem irt ki semmit";
      state_en = "nothing written yet";
     }
   else
     {
      state_hu = "mukodik";
      state_en = "running";
     }

   Comment(
      "GOLD_Live_Export  (" + gSymbol + " -> MQL4\\Files\\" + OutFileName + ")\n",
      "HU: ", state_hu,
      "  |  kiiras ", RefreshSeconds, " mp-enkent",
      "  |  sikeres: ", gWrites, ", sikertelen: ", gFailures,
      "  |  utolso: ", TimeToStr(TimeLocal(), TIME_SECONDS), "\n",
      "EN: ", state_en,
      "  |  writes every ", RefreshSeconds, "s",
      "  |  ok: ", gWrites, ", failed: ", gFailures,
      "  |  last: ", TimeToStr(TimeLocal(), TIME_SECONDS)
   );
  }
//+------------------------------------------------------------------+
