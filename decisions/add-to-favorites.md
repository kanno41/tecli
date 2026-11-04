# Add a project line to favorites (tecli-09a)

Capture: `captured/add-favorite/` (25 requests). User added a typed-code line, selected it, clicked Add to favorites, did not save.

## Protocol (request 024)
- CMD 300 action `TMMTS_ADD_LINE_TO_FAVORITES`, same CMD 300 shape as `TMMTS_NEW_TS_LINE` (`$actionId$`, `$restartFl$=false`, `C-59999`, `$longRunActionFl$=0`, `$procUniqueId$`, `K1`, `P0`).
- Preceded by the usual context PUTs, first one marked `$rsRowSelectedFlOnly$=true X0 K1 C-59999` (the selected row, editFlag 83, rowNumber -59999), then the plain K1 PUT, then `$rsContextOnly$` K0 and K1 PUTs.
- Followed by the standard refetch (K0 C0, K1 X0 C-59999). Response is all `<OK>`, no message text.
- It ran on the pending (unsaved) line, so a favorite can be created right after `add()` and before `save()`.
- Not captured: the action on a saved row (positive row number), and a visible success message. Verify success by listing favorites afterward.
