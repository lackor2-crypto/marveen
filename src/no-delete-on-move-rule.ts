// The owner's law (2026-11-23): when asked to MOVE a file, never delete anything; stop and tell on a name clash.
// ONE wording per language, shared by every prompt that reaches a code session, so it cannot drift.
export const NO_DELETE_ON_MOVE_DISPATCH_HU =
  'ATHELYEZESKOR SOHA NEM TOROLSZ (a tulajdonos torvenye): ha fajlt/mappat kell athelyezni, csak masolsz (nem irsz felul semmit), a forrast NEM torlod, es a celnal levo fajlt sem. Ha a celban azonos nev vagy azonos tartalom van, ALLJ MEG es szolj a tulajdonosnak. A forras torlese kulon kerdes, es csak az o kifejezett engedelyevel tortenhet; az egyezo bajtszam vagy a sikeres masolat nem engedely a torlesre.'
export const NO_DELETE_ON_MOVE_DISPATCH_EN =
  'NEVER DELETE WHEN ASKED TO MOVE (the owner\'s law): when a file or folder must be moved, only copy (overwrite nothing), do NOT delete the source and do NOT delete anything at the destination. If the destination has the same name or the same content, STOP and tell the owner. Deleting the source is a separate question and happens only with the owner\'s explicit permission; identical bytes or a successful copy are not permission to delete.'
