# Pay type and work location on add

Capture: `captured/work-location/` (nothing saved).

## Findings
- Work location is K1 col 8 (`UDT03_ID`), a zip code. Col 17 stays empty on new charge-code rows (`00` only on leave lines). The old doc label "PLC" for col 8 was wrong.
- Server fills the default into col 8 after charge resolution (req 016: `62221`), same step that fills col 16 (`REG`) and col 15.
- Browser change sequence (req 021, after typing char by char with `RAUTO` autocomplete on `TC_SIMPLE_UDT03_LKP`, reqs 017-020):
  1. `205` PUT K1 with col 8 = new zip (editFlag 19, row -59999), final value only is needed
  2. `208` VALIDATE `objectId=UDT03_ID`
  3. `204` refresh K0/K1
- Lookup list is a prefix-searched zip table (thousands of rows). Not offered as a choice list; zip is free text, server validates.
- Pay type (col 16) has a lookup (`TC_SIMPLE_UDT10_LKP`, req 022) but no set request was captured. Pay type stays chosen through the K2 charge row (multi-charge codes). No change for single-charge codes.

## Decision
- `add(code, payType, { workLocation })`: after final validate, PUT col 8 + `208 UDT03_ID`. No option means no extra requests.
- No `getWorkLocations()`.
- `pendingLine()` exposes server defaults `{ payType, workLocation }`.
